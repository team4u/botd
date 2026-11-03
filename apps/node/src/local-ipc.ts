import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { BirpcReturn } from 'birpc';
import { validateUiSpec, type HubRpcFunctions, type NodeRpcFunctions, type AskPreviewType } from '@botd/protocol';
import { assertSafeId, ensureDir, getIpcTokenFilePath } from './storage.js';
import type { BgJobManager } from './bg-jobs.js';
import { getNodeVersion, checkNodeUpgrade, performNodeUpgrade, UpgradeRejectedError } from './upgrader.js';

export const MAX_WAKE_BODY_BYTES = 64 * 1024;
export const MAX_ARTIFACT_BODY_BYTES = 15 * 1024 * 1024;
export const MAX_ASK_BODY_BYTES = 512 * 1024;

/** HTTP header carrying the local IPC auth token (the CLI reads the same
 *  token from <dataDir>/ipc-token). Contract fixed with the CLI side. */
export const IPC_TOKEN_HEADER = 'x-botd-ipc-token';

export interface LocalIpcDeps {
  identity: {
    nodeId: string;
    name: string;
    hubUrl: string;
    token?: string;
  };
  dataDir: string;
  socketPath: string;
  startedAt: number;
  isHubConnected: () => boolean;
  getHubRpc: () => BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null;
  bgManager: BgJobManager;
  syncRegistrationWithHub: () => Promise<void>;
  handleShutdown: () => void | Promise<void>;
  /** Local IPC auth token; read once at daemon startup (not hot-reloaded).
   *  When omitted, the server reads <dataDir>/ipc-token lazily on first
   *  request and caches it. When resolved to null (no token file exists),
   *  requests are still allowed: the transport (0600 Unix socket / per-user
   *  named pipe) remains machine-local and same-user. */
  ipcToken?: string | null;
}

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Constant-time comparison of the presented token against the daemon's
 *  token. Length mismatch fails fast (timingSafeEqual requires equal-length
 *  buffers). */
export function isValidIpcToken(presented: string | undefined, expected: string | null): boolean {
  if (!expected) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseJsonBody<T = any>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number = MAX_WAKE_BODY_BYTES,
): Promise<T | null> {
  return new Promise((resolve) => {
    req.setEncoding('utf8');
    let body = '';
    let exceeded = false;

    req.on('data', (chunk) => {
      if (exceeded) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        exceeded = true;
        sendJson(res, 413, { error: 'Payload Too Large' });
        req.destroy();
        resolve(null);
      }
    });

    req.on('end', () => {
      if (exceeded) return;
      try {
        resolve(body.trim() ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        resolve(null);
      }
    });

    req.on('error', () => {
      resolve(null);
    });
  });
}

export function requireHubRpc(deps: LocalIpcDeps): BirpcReturn<HubRpcFunctions, NodeRpcFunctions> {
  const hubRpc = deps.getHubRpc();
  if (!hubRpc || !deps.isHubConnected()) {
    const error: any = new Error('Hub connection not established');
    error.statusCode = 503;
    throw error;
  }
  return hubRpc;
}

/**
 * The request context every local IPC handler receives. Handlers must call
 * `req.resume()` before answering GET/prefix routes (no body follows) so the
 * socket does not stall, and may parse a JSON body (which consumes the
 * stream) on POST routes. Once a handler resolves, the body of the request
 * has been fully consumed.
 */
interface IpcContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** URL query params (prefix routes only, body-less requests). */
  query: URLSearchParams;
  /** JSON request body (POST routes only, null when unparsable/oversized;
   *  parseJsonBody has already sent the 413/400 response in that case). */
  body: any;
  deps: LocalIpcDeps;
}

/** A single local IPC route. Exactly one handler runs per request. */
interface IpcRoute {
  method: 'GET' | 'POST';
  /** Exact path match, or path prefix when `prefix` is true. */
  path: string;
  prefix?: boolean;
  /** JSON body size cap for POST routes (defaults to MAX_WAKE_BODY_BYTES). */
  maxBodyBytes?: number;
  handler: (ctx: IpcContext) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// daemon management: status, upgrade, shutdown, reload
// ---------------------------------------------------------------------------

function handleStatus({ req, res, deps }: IpcContext): void {
  req.resume();
  sendJson(res, 200, {
    ok: true,
    nodeId: deps.identity.nodeId,
    name: deps.identity.name,
    hubUrl: deps.identity.hubUrl,
    dataDir: deps.dataDir,
    socketPath: deps.socketPath,
    logFile: process.env.BOTD_DAEMON_LOG || path.join(deps.dataDir, 'daemon.log'),
    pid: process.pid,
    uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    hubConnected: deps.isHubConnected(),
    version: getNodeVersion(),
  });
}

async function handleUpgradeCheck({ req, res, query, deps }: IpcContext): Promise<void> {
  req.resume();
  const registryUrl = query.get('registryUrl') || undefined;
  try {
    const result = await checkNodeUpgrade(deps.dataDir, { registryUrl });
    sendJson(res, 200, result);
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || String(err) });
  }
}

async function handleUpgrade({ res, body, deps }: IpcContext): Promise<void> {
  try {
    const result = await performNodeUpgrade(deps.dataDir, {
      targetVersion: body.targetVersion,
      registryUrl: body.registryUrl,
      force: body.force,
      onScheduleShutdown: () => {
        setTimeout(() => {
          void deps.handleShutdown();
        }, 100).unref();
      },
    });
    sendJson(res, 200, result);
  } catch (err: any) {
    // Rejected requests (downgrade/blocked) are client errors (400),
    // everything else is an upgrade failure (500).
    const statusCode = err instanceof UpgradeRejectedError ? 400 : 500;
    sendJson(res, statusCode, { error: err?.message || String(err) });
  }
}

function handleShutdown({ req, res, deps }: IpcContext): void {
  req.resume();
  sendJson(res, 200, { ok: true });
  setImmediate(() => { void deps.handleShutdown(); });
}

async function handleReload({ req, res, deps }: IpcContext): Promise<void> {
  req.resume();
  try {
    await deps.syncRegistrationWithHub();
  } catch (err: any) {
    // Contract with the CLI: hub not connected -> 503 with the reason.
    const message = err?.message || String(err);
    const statusCode = message.includes('hub not connected') || message.includes('Hub connection') ? 503 : 500;
    sendJson(res, statusCode, { error: message });
    return;
  }
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// wake & ask: forward turn requests to the hub over the birpc connection
// ---------------------------------------------------------------------------

async function handleWake({ res, body, deps }: IpcContext): Promise<void> {
  const { sessionId, botId, message, replyToBotId, noTurn, delaySeconds } = body;
  if (
    typeof sessionId !== 'string' ||
    typeof botId !== 'string' ||
    typeof message !== 'string' ||
    !sessionId.trim() ||
    !botId.trim()
  ) {
    sendJson(res, 400, { error: 'Missing or invalid sessionId, botId, or message' });
    return;
  }

  if (
    delaySeconds !== undefined &&
    !(typeof delaySeconds === 'number' && Number.isFinite(delaySeconds) && delaySeconds > 0)
  ) {
    sendJson(res, 400, { error: 'delaySeconds must be a positive number' });
    return;
  }

  assertSafeId(sessionId, 'Session ID');
  assertSafeId(botId, 'Bot ID');
  if (replyToBotId !== undefined) {
    assertSafeId(String(replyToBotId), 'Reply-To Bot ID');
  }

  const hubRpc = requireHubRpc(deps);

  const wakeRes = await hubRpc.requestWakeupTurn({
    sessionId,
    botId,
    wakeupMessage: String(message),
    ...(replyToBotId ? { replyToBotId: String(replyToBotId) } : {}),
    ...(noTurn ? { noTurn: true } : {}),
    ...(delaySeconds ? { delaySeconds: Math.floor(delaySeconds) } : {}),
  });

  sendJson(res, 200, { ok: true, ...(wakeRes && typeof wakeRes === 'object' ? wakeRes : {}) });
}

async function handleAsk({ res, body, deps }: IpcContext): Promise<void> {
  const { sessionId, botId, prompt, options, timeoutSeconds, previewType, previewContent } = body;
  if (
    typeof sessionId !== 'string' ||
    typeof botId !== 'string' ||
    typeof prompt !== 'string' ||
    !sessionId.trim() ||
    !botId.trim() ||
    !prompt.trim()
  ) {
    sendJson(res, 400, { error: 'Missing or invalid sessionId, botId, or prompt' });
    return;
  }

  assertSafeId(sessionId, 'Session ID');
  assertSafeId(botId, 'Bot ID');

  let normalizedPreviewContent = typeof previewContent === 'string' && previewContent ? previewContent : undefined;
  if (previewType === 'ui') {
    if (!normalizedPreviewContent || !normalizedPreviewContent.trim()) {
      sendJson(res, 400, { error: 'Missing or empty previewContent for UI preview' });
      return;
    }
    const validation = validateUiSpec(normalizedPreviewContent);
    if (!validation.ok) {
      sendJson(res, 400, { error: `Invalid UI spec: ${validation.errors.join('; ')}` });
      return;
    }
    normalizedPreviewContent = validation.normalizedJson;
  }

  const hubRpc = requireHubRpc(deps);

  const result = await hubRpc.requestHumanInput({
    sessionId,
    botId,
    prompt: String(prompt),
    ...(Array.isArray(options) ? { options: options.map(String) } : {}),
    ...(typeof timeoutSeconds === 'number' && timeoutSeconds >= 0 ? { timeoutSeconds } : {}),
    ...(previewType === 'diff' || previewType === 'markdown' || previewType === 'text' || previewType === 'ui'
      ? { previewType: previewType as AskPreviewType }
      : {}),
    ...(normalizedPreviewContent ? { previewContent: normalizedPreviewContent } : {}),
  });

  sendJson(res, 200, { ok: true, answer: result.answer });
}

// ---------------------------------------------------------------------------
// background jobs (bg/*): managed shell jobs spawned in the bot workspace
// ---------------------------------------------------------------------------

async function handleBgRun({ res, body, deps }: IpcContext): Promise<void> {
  const { sessionId, botId, command, replyToBotId, noTurnOnComplete } = body;
  if (
    typeof sessionId !== 'string' ||
    typeof botId !== 'string' ||
    typeof command !== 'string' ||
    !sessionId.trim() ||
    !botId.trim() ||
    !command.trim()
  ) {
    sendJson(res, 400, { error: 'Missing or invalid sessionId, botId, or command' });
    return;
  }

  const job = await deps.bgManager.startJob({
    sessionId,
    botId,
    command,
    ...(replyToBotId ? { replyToBotId: String(replyToBotId) } : {}),
    ...(noTurnOnComplete ? { noTurnOnComplete: true } : {}),
  });
  sendJson(res, 200, { ok: true, job });
}

function handleBgList({ req, res, query, deps }: IpcContext): void {
  req.resume();
  const sessionId = query.get('sessionId') || undefined;
  const botId = query.get('botId') || undefined;
  sendJson(res, 200, { ok: true, jobs: deps.bgManager.listJobs({ sessionId, botId }) });
}

async function handleBgLogs({ req, res, query, deps }: IpcContext): Promise<void> {
  req.resume();
  const jobId = query.get('jobId') || '';
  const lines = Number(query.get('lines')) || 100;
  if (!jobId.trim()) {
    sendJson(res, 400, { error: 'Missing or invalid jobId' });
    return;
  }
  const result = await deps.bgManager.getJobLogs(jobId, lines);
  sendJson(res, 200, { ok: true, ...result });
}

async function handleBgKill({ res, body, deps }: IpcContext): Promise<void> {
  const { jobId } = body;
  if (typeof jobId !== 'string' || !jobId.trim()) {
    sendJson(res, 400, { error: 'Missing or invalid jobId' });
    return;
  }
  const job = await deps.bgManager.killJob(jobId);
  sendJson(res, 200, { ok: true, job });
}

// ---------------------------------------------------------------------------
// artifacts (artifact/*): upload/download session artifacts via the hub HTTP
// API when node credentials exist, falling back to the birpc connection
// ---------------------------------------------------------------------------

async function handleArtifactPut({ res, body, deps }: IpcContext): Promise<void> {
  const { sessionId, botId, filePath, message, mimeType } = body;
  let { filename, contentBase64 } = body;

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    sendJson(res, 400, { error: 'Missing or invalid sessionId' });
    return;
  }

  assertSafeId(sessionId, 'Session ID');
  if (botId) {
    assertSafeId(String(botId), 'Bot ID');
  }

  let fileBuffer: Buffer | null = null;
  if (filePath && !contentBase64) {
    const resolvedPath = path.resolve(String(filePath));
    fileBuffer = await fs.readFile(resolvedPath);
    if (!filename) {
      filename = path.basename(resolvedPath);
    }
  } else if (typeof contentBase64 === 'string') {
    fileBuffer = Buffer.from(contentBase64, 'base64');
  }

  if (typeof filename !== 'string' || !filename.trim() || !fileBuffer) {
    sendJson(res, 400, { error: 'Missing filename or contentBase64' });
    return;
  }

  let uploadedArtifact: any = null;

  if (deps.identity.token && deps.identity.hubUrl) {
    try {
      const uploadUrl = `${deps.identity.hubUrl.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/artifacts`;
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'x-botd-node-id': deps.identity.nodeId,
        'x-botd-node-token': deps.identity.token,
        'x-artifact-filename': encodeURIComponent(filename),
        ...(mimeType ? { 'x-artifact-mime-type': String(mimeType) } : {}),
        ...(botId ? { 'x-artifact-bot-id': String(botId) } : {}),
        ...(message ? { 'x-artifact-message': encodeURIComponent(String(message)) } : {}),
      };

      const resp = await fetch(uploadUrl, {
        method: 'POST',
        headers,
        body: new Uint8Array(fileBuffer),
      });

      if (resp.ok) {
        uploadedArtifact = await resp.json();
      }
    } catch {
      // Network or HTTP error -> fallback to hubRpc
    }
  }

  if (!uploadedArtifact) {
    const hubRpc = requireHubRpc(deps);
    const base64Content = typeof contentBase64 === 'string'
      ? contentBase64
      : fileBuffer.toString('base64');

    uploadedArtifact = await hubRpc.uploadArtifact({
      sessionId,
      ...(botId ? { botId: String(botId) } : {}),
      filename: String(filename),
      ...(mimeType ? { mimeType: String(mimeType) } : {}),
      contentBase64: base64Content,
      ...(message ? { message: String(message) } : {}),
    });
  }

  sendJson(res, 200, { ok: true, artifact: uploadedArtifact, ...uploadedArtifact });
}

function artifactRecordFromResponse(
  artifactId: string,
  fileBuffer: Buffer,
  resp: Response,
): any {
  let filename = '';
  const disp = resp.headers.get('content-disposition');
  if (disp) {
    const match = disp.match(/filename="?([^";]+)"?/i);
    if (match && match[1]) {
      try {
        filename = decodeURIComponent(match[1]);
      } catch {
        filename = match[1];
      }
    }
  }

  const record: any = {
    id: resp.headers.get('x-artifact-id') || artifactId,
    sessionId: resp.headers.get('x-artifact-session-id') || '',
    filename: filename || `artifact-${artifactId}`,
    mimeType: resp.headers.get('content-type') || 'application/octet-stream',
    sizeBytes: fileBuffer.length,
    createdAt: resp.headers.get('x-artifact-created-at') || new Date().toISOString(),
  };
  const senderBotId = resp.headers.get('x-artifact-sender-bot-id');
  if (senderBotId) {
    record.senderBotId = senderBotId;
  }
  return record;
}

async function handleArtifactPull({ res, body, deps }: IpcContext): Promise<void> {
  const { artifactId, outputPath } = body;
  if (typeof artifactId !== 'string' || !artifactId.trim()) {
    sendJson(res, 400, { error: 'Missing or invalid artifactId' });
    return;
  }

  let fileBuffer: Buffer | null = null;
  let artifactRecord: any = null;

  if (deps.identity.token && deps.identity.hubUrl) {
    try {
      const pullUrl = `${deps.identity.hubUrl.replace(/\/$/, '')}/api/artifacts/${encodeURIComponent(artifactId)}/content`;
      const resp = await fetch(pullUrl, {
        method: 'GET',
        headers: {
          'x-botd-node-id': deps.identity.nodeId,
          'x-botd-node-token': deps.identity.token,
        },
      });

      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
        artifactRecord = artifactRecordFromResponse(artifactId, fileBuffer, resp);
      }
    } catch {
      // Network or HTTP error -> fallback to hubRpc
    }
  }

  let savedTo: string | undefined;
  let contentBase64: string | undefined;

  if (fileBuffer && artifactRecord) {
    if (outputPath) {
      savedTo = path.resolve(String(outputPath));
      await ensureDir(path.dirname(savedTo));
      await fs.writeFile(savedTo, fileBuffer);
    } else {
      contentBase64 = fileBuffer.toString('base64');
    }
    sendJson(res, 200, {
      ok: true,
      artifact: artifactRecord,
      ...artifactRecord,
      ...(savedTo ? { savedTo } : { contentBase64 }),
    });
    return;
  }

  const hubRpc = requireHubRpc(deps);

  const result = await hubRpc.downloadArtifact(String(artifactId));
  if (outputPath) {
    savedTo = path.resolve(String(outputPath));
    await ensureDir(path.dirname(savedTo));
    await fs.writeFile(savedTo, Buffer.from(result.contentBase64, 'base64'));
  }

  sendJson(res, 200, {
    ok: true,
    artifact: result.artifact,
    ...result.artifact,
    ...(savedTo ? { savedTo } : { contentBase64: result.contentBase64 }),
  });
}

async function handleArtifactList({ req, res, query, deps }: IpcContext): Promise<void> {
  req.resume();
  const sessionId = query.get('sessionId');
  if (!sessionId || !sessionId.trim()) {
    sendJson(res, 400, { error: 'Missing or invalid sessionId' });
    return;
  }

  assertSafeId(sessionId, 'Session ID');

  const hubRpc = requireHubRpc(deps);

  const artifacts = await hubRpc.listSessionArtifacts(sessionId);
  sendJson(res, 200, { ok: true, artifacts });
}

// ---------------------------------------------------------------------------
// server assembly: token resolution, route table, dispatch, error mapping
// ---------------------------------------------------------------------------

/** Route table; order is irrelevant, paths are unique per method. */
const ROUTES: IpcRoute[] = [
  { method: 'GET', path: '/status', handler: handleStatus },
  { method: 'GET', path: '/upgrade/check', prefix: true, handler: handleUpgradeCheck },
  { method: 'POST', path: '/upgrade', handler: handleUpgrade },
  { method: 'POST', path: '/shutdown', handler: handleShutdown },
  { method: 'POST', path: '/reload', handler: handleReload },
  { method: 'POST', path: '/wake', handler: handleWake },
  { method: 'POST', path: '/bg/run', handler: handleBgRun },
  { method: 'GET', path: '/bg/list', prefix: true, handler: handleBgList },
  { method: 'GET', path: '/bg/logs', prefix: true, handler: handleBgLogs },
  { method: 'POST', path: '/bg/kill', handler: handleBgKill },
  { method: 'POST', path: '/ask', maxBodyBytes: MAX_ASK_BODY_BYTES, handler: handleAsk },
  { method: 'POST', path: '/artifact/put', maxBodyBytes: MAX_ARTIFACT_BODY_BYTES, handler: handleArtifactPut },
  { method: 'POST', path: '/artifact/pull', handler: handleArtifactPull },
  { method: 'GET', path: '/artifact/list', prefix: true, handler: handleArtifactList },
];

/** Map an unhandled handler error to a response status code: explicit
 *  err.statusCode wins; message heuristics preserve the historical contract
 *  (e.g. assertSafeId("... invalid ...") -> 400, job "not found" -> 404). */
function sendErrorResponse(res: http.ServerResponse, err: any): void {
  if (res.headersSent) return;
  const statusCode =
    typeof err.statusCode === 'number'
      ? err.statusCode
      : err.message?.includes('invalid')
        ? 400
        : err.message?.includes('not found')
          ? 404
          : 500;
  sendJson(res, statusCode, { error: err.message || 'Internal server error' });
}

/** Reads the raw request body so the stream is consumed even when the route
 *  does not use it (e.g. unauthorized requests on POST routes); errors are
 *  swallowed like before (the handler's response wins). */
async function discardRequestBody(req: http.IncomingMessage): Promise<void> {
  req.on('error', () => {});
  req.on('data', () => {});
  await new Promise<void>((resolve) => req.on('end', resolve));
}

export function createLocalIpcServer(deps: LocalIpcDeps): http.Server {
  // Token is read once (startup or first request) and cached; the token file
  // is NOT hot-reloaded.
  let cachedToken: string | null | undefined = deps.ipcToken;

  const resolveToken = async (): Promise<string | null> => {
    if (cachedToken !== undefined) return cachedToken;
    try {
      const raw = await fs.readFile(getIpcTokenFilePath(deps.dataDir), 'utf8');
      cachedToken = raw.trim() || null;
    } catch {
      cachedToken = null;
    }
    return cachedToken;
  };

  return http.createServer(async (req, res) => {
    try {
      const reqUrl = req.url || '/';

      // Local IPC auth: when a token exists, every request must present it in
      // the x-botd-ipc-token header (constant-time compare), else 401.
      const expectedToken = await resolveToken();
      if (expectedToken && !isValidIpcToken(req.headers[IPC_TOKEN_HEADER] as string | undefined, expectedToken)) {
        void discardRequestBody(req);
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const route = ROUTES.find(
        (r) => req.method === r.method && (reqUrl === r.path || (r.prefix && reqUrl.startsWith(r.path))),
      );

      if (route?.method === 'POST') {
        const body = await parseJsonBody(req, res, route.maxBodyBytes ?? MAX_WAKE_BODY_BYTES);
        if (body === null) return;
        await route.handler({ req, res, query: new URL(reqUrl, 'http://localhost').searchParams, body, deps });
      } else if (route) {
        await route.handler({ req, res, query: new URL(reqUrl, 'http://localhost').searchParams, body: undefined, deps });
      } else {
        req.resume();
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });
}
