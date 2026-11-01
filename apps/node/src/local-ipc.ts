import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BirpcReturn } from 'birpc';
import type { HubRpcFunctions, NodeRpcFunctions } from '@botd/protocol';
import { assertSafeId, ensureDir } from './storage.js';
import type { BgJobManager } from './bg-jobs.js';
import { getNodeVersion, checkNodeUpgrade, performNodeUpgrade } from './upgrader.js';

export const MAX_WAKE_BODY_BYTES = 64 * 1024;
export const MAX_ARTIFACT_BODY_BYTES = 15 * 1024 * 1024;

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
}

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
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

export function createLocalIpcServer(deps: LocalIpcDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const method = req.method;
      const reqUrl = req.url || '/';

      if (method === 'GET' && reqUrl === '/status') {
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
        return;
      }

      if (method === 'GET' && reqUrl.startsWith('/upgrade/check')) {
        req.resume();
        const urlObj = new URL(reqUrl, 'http://localhost');
        const registryUrl = urlObj.searchParams.get('registryUrl') || undefined;
        try {
          const result = await checkNodeUpgrade(deps.dataDir, { registryUrl });
          sendJson(res, 200, result);
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message || String(err) });
        }
        return;
      }

      if (method === 'POST' && reqUrl === '/upgrade') {
        const payload = await parseJsonBody<{ targetVersion?: string; registryUrl?: string; force?: boolean }>(
          req,
          res,
          MAX_WAKE_BODY_BYTES,
        );
        if (!payload) return;
        try {
          const result = await performNodeUpgrade(deps.dataDir, {
            targetVersion: payload.targetVersion,
            registryUrl: payload.registryUrl,
            force: payload.force,
            onScheduleShutdown: () => {
              setTimeout(() => {
                void deps.handleShutdown();
              }, 100).unref();
            },
          });
          sendJson(res, 200, result);
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message || String(err) });
        }
        return;
      }

      if (method === 'POST' && reqUrl === '/shutdown') {
        req.resume();
        sendJson(res, 200, { ok: true });
        setImmediate(() => { void deps.handleShutdown(); });
        return;
      }

      if (method === 'POST' && reqUrl === '/reload') {
        req.resume();
        await deps.syncRegistrationWithHub();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'POST' && reqUrl === '/wake') {
        const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
        if (!payload) return;

        const { sessionId, botId, message, replyToBotId, noTurn, delaySeconds } = payload;
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
        return;
      }

      if (method === 'POST' && reqUrl === '/bg/run') {
        const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
        if (!payload) return;

        const { sessionId, botId, command, replyToBotId, noTurnOnComplete } = payload;
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
        return;
      }

      if (method === 'GET' && reqUrl.startsWith('/bg/list')) {
        req.resume();
        const parsed = new URL(reqUrl, 'http://localhost');
        const sessionId = parsed.searchParams.get('sessionId') || undefined;
        const botId = parsed.searchParams.get('botId') || undefined;
        sendJson(res, 200, { ok: true, jobs: deps.bgManager.listJobs({ sessionId, botId }) });
        return;
      }

      if (method === 'GET' && reqUrl.startsWith('/bg/logs')) {
        req.resume();
        const parsed = new URL(reqUrl, 'http://localhost');
        const jobId = parsed.searchParams.get('jobId') || '';
        const lines = Number(parsed.searchParams.get('lines')) || 100;
        if (!jobId.trim()) {
          sendJson(res, 400, { error: 'Missing or invalid jobId' });
          return;
        }
        const result = await deps.bgManager.getJobLogs(jobId, lines);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === 'POST' && reqUrl === '/bg/kill') {
        const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
        if (!payload) return;

        const { jobId } = payload;
        if (typeof jobId !== 'string' || !jobId.trim()) {
          sendJson(res, 400, { error: 'Missing or invalid jobId' });
          return;
        }
        const job = await deps.bgManager.killJob(jobId);
        sendJson(res, 200, { ok: true, job });
        return;
      }

      if (method === 'POST' && reqUrl === '/ask') {
        const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
        if (!payload) return;

        const { sessionId, botId, prompt, options, timeoutSeconds } = payload;
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

        const hubRpc = requireHubRpc(deps);

        const result = await hubRpc.requestHumanInput({
          sessionId,
          botId,
          prompt: String(prompt),
          ...(Array.isArray(options) ? { options: options.map(String) } : {}),
          ...(typeof timeoutSeconds === 'number' && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
        });

        sendJson(res, 200, { ok: true, answer: result.answer });
        return;
      }

      if (method === 'POST' && reqUrl === '/artifact/put') {
        const payload = await parseJsonBody(req, res, MAX_ARTIFACT_BODY_BYTES);
        if (!payload) return;

        const { sessionId, botId, filePath, message, mimeType } = payload;
        let { filename, contentBase64 } = payload;

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
        return;
      }

      if (method === 'POST' && reqUrl === '/artifact/pull') {
        const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
        if (!payload) return;

        const { artifactId, outputPath } = payload;
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

              artifactRecord = {
                id: resp.headers.get('x-artifact-id') || artifactId,
                sessionId: resp.headers.get('x-artifact-session-id') || '',
                filename: filename || `artifact-${artifactId}`,
                mimeType: resp.headers.get('content-type') || 'application/octet-stream',
                sizeBytes: fileBuffer.length,
                createdAt: resp.headers.get('x-artifact-created-at') || new Date().toISOString(),
              };
              const senderBotId = resp.headers.get('x-artifact-sender-bot-id');
              if (senderBotId) {
                artifactRecord.senderBotId = senderBotId;
              }
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
        return;
      }

      if (method === 'GET' && reqUrl.startsWith('/artifact/list')) {
        req.resume();
        const parsed = new URL(reqUrl, 'http://localhost');
        const sessionId = parsed.searchParams.get('sessionId');
        if (!sessionId || !sessionId.trim()) {
          sendJson(res, 400, { error: 'Missing or invalid sessionId' });
          return;
        }

        assertSafeId(sessionId, 'Session ID');

        const hubRpc = requireHubRpc(deps);

        const artifacts = await hubRpc.listSessionArtifacts(sessionId);
        sendJson(res, 200, { ok: true, artifacts });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
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
  });
}
