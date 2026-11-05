import net from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import ReconnectingWebSocket from 'partysocket/ws';
import { WebSocket as WsWebSocket } from 'ws';
import { createBirpc, type BirpcReturn } from 'birpc';
import {
  type HubRpcFunctions,
  type NodeRpcFunctions,
  type PlatformType,
  serializeRpcMessage,
} from '@botd/protocol';
import {
  assertSafeId,
  deleteBot,
  deleteResource,
  ensureDir,
  ensureIpcToken,
  getDataDir,
  getDaemonSocketPath,
  listBots,
  listExtensions,
  listSkills,
  readIpcToken,
  readResourcePackageDir,
  readFileTarget,
  readBot,
  readNodeIdentity,
  saveBot,
  seedStorageIfEmpty,
  writeFileTarget,
} from './storage.js';
import {
  buildBotShellEnv,
  ensureBotdBinWrapper,
} from './runtime.js';
import { installResourceToNode } from './installer.js';
import { ensureBuiltinSkill } from './builtin-skill.js';
import { createNodeEnvRpcServer } from './env-rpc-server.js';
import { ensureWindowsShell, isWindows } from './windows-shell.js';
import { notifyDaemonReady, spawnReplacementDaemon } from './daemon-launch.js';
import {
  getNodeVersion,
  checkNodeUpgrade,
  performNodeUpgrade,
  filterRpcRegistryUrl,
  UpgradeRejectedError,
} from './upgrader.js';

export interface DaemonHandle {
  nodeId: string;
  hubUrl: string;
  socketPath: string;
  dataDir: string;
  close: () => Promise<void>;
}

async function checkOrCleanSocket(socketPath: string): Promise<void> {
  // Named pipes vanish with their owning process; just probe liveness.
  if (process.platform === 'win32') {
    const isLive = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (isLive) {
      throw new Error(`Another botd daemon is already listening on ${socketPath}`);
    }
    return;
  }
  if (!existsSync(socketPath)) return;

  const isLive = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });

  if (isLive) {
    throw new Error(`Another botd daemon is already listening on ${socketPath}`);
  }

  await fs.unlink(socketPath).catch(() => {});
}

/**
 * 本地守护进程控制面（Unix socket / Windows 命名管道上的极简 HTTP）：
 * 只服务 CLI 的进程管理（status/shutdown/reload）与回合计入面
 * （wake/artifact），全部转发给 Hub；无任何本地状态。
 */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ARTIFACT_BODY_BYTES = 15 * 1024 * 1024;
const IPC_TOKEN_HEADER = 'x-botd-ipc-token';

/** daemon 控制面依赖：全部为可注入回调，无本地状态（测试可用 mock hub 构建进程内实例）。 */
export interface ControlDeps {
  dataDir: string;
  socketPath: string;
  startedAt: number;
  identity: { nodeId: string; name: string; hubUrl: string; token?: string };
  ipcToken?: string | null;
  isHubConnected: () => boolean;
  getHubRpc: () => BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null;
  syncRegistrationWithHub: () => Promise<void>;
  handleShutdown: () => void;
  /** 在途 envExec（bash 命令）计数：升级排空等待的依据；缺省视为 0。 */
  getActiveExecCount?: () => number;
}

function isValidIpcToken(presented: string | undefined, expected: string | null | undefined): boolean {
  if (!expected) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse, maxBytes: number = MAX_BODY_BYTES): Promise<any> {
  return new Promise((resolve) => {
    req.setEncoding('utf8');
    let body = '';
    let exceeded = false;
    req.on('data', (chunk: string) => {
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
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function requireHubRpc(deps: ControlDeps): BirpcReturn<HubRpcFunctions, NodeRpcFunctions> {
  const hubRpc = deps.getHubRpc();
  if (!hubRpc || !deps.isHubConnected()) {
    const error: any = new Error('Hub connection not established');
    error.statusCode = 503;
    throw error;
  }
  return hubRpc;
}

/** 创建本地守护进程控制面服务器（Unix socket / Windows 命名管道上的极简 HTTP）。 */
export function createDaemonControlServer(deps: ControlDeps): http.Server {
  const handleStatus = (req: http.IncomingMessage, res: http.ServerResponse) => {
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
  };

  const handleShutdown = (req: http.IncomingMessage, res: http.ServerResponse) => {
    req.resume();
    sendJson(res, 200, { ok: true });
    setImmediate(() => deps.handleShutdown());
  };

  const handleUpgradeCheck = async (req: http.IncomingMessage, res: http.ServerResponse, { url }: { url: URL }) => {
    req.resume();
    const registryUrl = url.searchParams.get('registryUrl') || undefined;
    try {
      const result = await checkNodeUpgrade(deps.dataDir, { registryUrl });
      sendJson(res, 200, result);
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
  };

  const handleUpgrade = async (_req: http.IncomingMessage, res: http.ServerResponse, { body }: { body: any }) => {
    try {
      const result = await performNodeUpgrade(deps.dataDir, {
        targetVersion: body?.targetVersion,
        registryUrl: body?.registryUrl,
        force: body?.force,
        // 排空保护：升级前等待在途 envExec（bash 命令）结束再拉起替换守护进程。
        getActiveTurnsCount: deps.getActiveExecCount ?? (() => 0),
        onScheduleShutdown: () => {
          setTimeout(() => {
            deps.handleShutdown();
          }, 100).unref();
        },
      });
      sendJson(res, 200, result);
    } catch (err: any) {
      const statusCode = err instanceof UpgradeRejectedError ? 400 : 500;
      sendJson(res, statusCode, { error: err?.message || String(err) });
    }
  };

  const handleReload = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    req.resume();
    try {
      await deps.syncRegistrationWithHub();
      sendJson(res, 200, { ok: true });
    } catch (err: any) {
      const message = err?.message || String(err);
      const statusCode = message.includes('hub not connected') || message.includes('Hub connection') ? 503 : 500;
      sendJson(res, statusCode, { error: message });
    }
  };

  const handleWake = async (_req: http.IncomingMessage, res: http.ServerResponse, { body }: { body: any }) => {
    const { sessionId, botId, message, replyToBotId, noTurn, delaySeconds } = body ?? {};
    if (typeof sessionId !== 'string' || typeof botId !== 'string' || typeof message !== 'string' || !sessionId.trim() || !botId.trim()) {
      sendJson(res, 400, { error: 'Missing or invalid sessionId, botId, or message' });
      return;
    }
    if (delaySeconds !== undefined && !(typeof delaySeconds === 'number' && Number.isFinite(delaySeconds) && delaySeconds > 0)) {
      sendJson(res, 400, { error: 'delaySeconds must be a positive number' });
      return;
    }
    assertSafeId(sessionId, 'Session ID');
    assertSafeId(botId, 'Bot ID');
    if (replyToBotId !== undefined) assertSafeId(String(replyToBotId), 'Reply-To Bot ID');
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
  };

  const handleArtifactPut = async (_req: http.IncomingMessage, res: http.ServerResponse, { body }: { body: any }) => {
    const { sessionId, botId, filePath, message, mimeType } = body ?? {};
    let { filename, contentBase64 } = body ?? {};
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      sendJson(res, 400, { error: 'Missing or invalid sessionId' });
      return;
    }
    assertSafeId(sessionId, 'Session ID');
    if (botId) assertSafeId(String(botId), 'Bot ID');

    let fileBuffer: Buffer | null = null;
    if (filePath && !contentBase64) {
      const resolvedPath = path.resolve(String(filePath));
      fileBuffer = await fs.readFile(resolvedPath);
      if (!filename) filename = path.basename(resolvedPath);
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
        const resp = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-botd-node-id': deps.identity.nodeId,
            'x-botd-node-token': deps.identity.token,
            'x-artifact-filename': encodeURIComponent(filename),
            ...(mimeType ? { 'x-artifact-mime-type': String(mimeType) } : {}),
            ...(botId ? { 'x-artifact-bot-id': String(botId) } : {}),
            ...(message ? { 'x-artifact-message': encodeURIComponent(String(message)) } : {}),
          },
          body: new Uint8Array(fileBuffer),
        });
        if (resp.ok) uploadedArtifact = await resp.json();
      } catch {
        // Network or HTTP error -> fallback to hubRpc
      }
    }
    if (!uploadedArtifact) {
      const hubRpc = requireHubRpc(deps);
      const base64Content = typeof contentBase64 === 'string' ? contentBase64 : fileBuffer.toString('base64');
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
  };

  const artifactRecordFromResponse = (artifactId: string, fileBuffer: Buffer, resp: Response): any => {
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
    if (senderBotId) record.senderBotId = senderBotId;
    return record;
  };

  const handleArtifactPull = async (_req: http.IncomingMessage, res: http.ServerResponse, { body }: { body: any }) => {
    const { artifactId, outputPath } = body ?? {};
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
      sendJson(res, 200, { ok: true, artifact: artifactRecord, ...artifactRecord, ...(savedTo ? { savedTo } : { contentBase64 }) });
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
  };

  const handleArtifactList = async (req: http.IncomingMessage, res: http.ServerResponse, { url }: { url: URL }) => {
    req.resume();
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId || !sessionId.trim()) {
      sendJson(res, 400, { error: 'Missing or invalid sessionId' });
      return;
    }
    assertSafeId(sessionId, 'Session ID');
    const hubRpc = requireHubRpc(deps);
    const artifacts = await hubRpc.listSessionArtifacts(sessionId);
    sendJson(res, 200, { ok: true, artifacts });
  };

  const routes: { method: 'GET' | 'POST'; match: (url: string) => boolean; maxBodyBytes?: number; handler: (req: http.IncomingMessage, res: http.ServerResponse, ctx: { url: URL; body: any }) => Promise<void> | void }[] = [
    { method: 'GET', match: (u) => u === '/status', handler: handleStatus },
    { method: 'POST', match: (u) => u === '/shutdown', handler: handleShutdown },
    { method: 'POST', match: (u) => u === '/reload', handler: handleReload },
    { method: 'GET', match: (u) => u === '/upgrade/check' || u.startsWith('/upgrade/check?'), handler: handleUpgradeCheck },
    { method: 'POST', match: (u) => u === '/upgrade', handler: handleUpgrade },
    { method: 'POST', match: (u) => u === '/wake', handler: handleWake },
    { method: 'POST', match: (u) => u === '/artifact/put', maxBodyBytes: MAX_ARTIFACT_BODY_BYTES, handler: handleArtifactPut },
    { method: 'POST', match: (u) => u === '/artifact/pull', handler: handleArtifactPull },
    { method: 'GET', match: (u) => u === '/artifact/list' || u.startsWith('/artifact/list?'), handler: handleArtifactList },
  ];

  return http.createServer(async (req, res) => {
    try {
      const reqUrl = req.url || '/';
      if (deps.ipcToken && !isValidIpcToken(req.headers[IPC_TOKEN_HEADER] as string | undefined, deps.ipcToken)) {
        req.resume();
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const route = routes.find((r) => req.method === r.method && r.match(reqUrl));
      if (!route) {
        req.resume();
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      const url = new URL(reqUrl, 'http://localhost');
      const body = route.method === 'POST' ? await readJsonBody(req, res, route.maxBodyBytes) : undefined;
      if (body === null) return;
      await route.handler(req, res, { url, body });
    } catch (err: any) {
      if (!res.headersSent) {
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
    }
  });
}

export async function startDaemon(dataDirOverride?: string): Promise<DaemonHandle> {
  const dataDir = getDataDir(dataDirOverride);
  await ensureDir(dataDir, 0o700);

  const identity = await readNodeIdentity(dataDir);
  if (!identity) {
    throw new Error(`Node is not paired. Run "botd join <hubUrl> --code <code> --name <name>" first.`);
  }

  await seedStorageIfEmpty(dataDir, identity.nodeId);
  await ensureBuiltinSkill(dataDir);
  const binDir = await ensureBotdBinWrapper(dataDir);

  // Windows needs a resolvable bash.exe for the Pi bash tool; resolve or
  // download a portable MinGit once before serving any traffic.
  if (isWindows) {
    await ensureWindowsShell(dataDir);
  }

  // Local IPC auth token (<dataDir>/ipc-token, 0600): generated once, read
  // once per start (no hot reload).
  await ensureIpcToken(dataDir).catch((err) => {
    console.error('Failed to ensure IPC token:', err);
  });
  const ipcToken = await readIpcToken(dataDir);

  const socketPath = getDaemonSocketPath(dataDir);
  const pidFilePath = path.join(dataDir, 'daemon.pid');

  const bindRetryMs = Number(process.env.BOTD_DAEMON_BIND_RETRY_MS || '0');
  const isReplacementDaemon = Number.isFinite(bindRetryMs) && bindRetryMs > 0;

  if (isReplacementDaemon) {
    // Replacement-daemon handshake: the outgoing parent still holds the
    // socket and only releases it after receiving our ready signal, so a
    // replacement can never bind before signaling (signaling here, before the
    // bind-retry loop, avoids that deadlock). The bind itself is still
    // verified by the loop below — if binding ultimately fails, this child
    // exits non-zero and the upgrade canary treats it as a failure.
    notifyDaemonReady();
  }
  let deadline = Date.now() + (Number.isFinite(bindRetryMs) ? bindRetryMs : 0);
  for (;;) {
    try {
      await checkOrCleanSocket(socketPath);
      break;
    } catch (err) {
      if (Date.now() >= deadline) throw err; // 立即失败保持原有语义（默认 retry=0）
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();

  // 远端执行环境 RPC 服务端（Brain in Hub, Hands on Node）：文件/shell/worktree
  // 能力在 Node 本机执行，流式输出经 onExecOutput 回传 Hub。
  // shellEnv 注入 botd CLI 包装器（~/.botd/bin → PATH 头部）与 BOTD_DATA_DIR，
  // 让 durable Worker 在回合内跑 bash 时开箱即用 `botd` 命令。
  const envRpcServer = createNodeEnvRpcServer({
    defaultCwd: dataDir,
    shellEnv: buildBotShellEnv(process.env, {
      dataDir,
      binDir,
      sessionId: '',
      botId: '',
      botEnv: {},
    }),
    onExecOutput: (event) => {
      try {
        hubRpc?.onEnvExecOutput?.(event);
      } catch {
        // 输出回传失败不影响命令本身（断连重连后新输出走新连接）
      }
    },
  });

  let isStopping = false;
  let hubRpc: BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  // restartDaemon 防重入标记：闭包内实例级状态，同一进程多个 daemon 实例互不污染。
  let restartRequested = false;
  // 被动升级（Phase 7A）：Node 不再自轮询 npm registry；升级由 Hub 中心化
  // 下发 upgradeDaemon RPC 或用户经 CLI/Web 显式触发。
  let rpcInstance: BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null = null;
  let rws: ReconnectingWebSocket;
  const syncRegistrationWithHub = async (targetRpc = hubRpc): Promise<void> => {
    if (isStopping) throw new Error('Daemon is shutting down');
    if (!targetRpc || !rws || rws.readyState !== ReconnectingWebSocket.OPEN) {
      // Surface the failure to callers (e.g. local-ipc /reload returns 503)
      // instead of silently returning success.
      throw new Error('hub not connected');
    }
    const bots = await listBots(dataDir);
    const skills = await listSkills(dataDir);
    const extensions = await listExtensions(dataDir);
    await targetRpc.registerNode({
      nodeId: identity.nodeId,
      name: identity.name,
      platform: process.platform as PlatformType,
      bots,
      skills,
      extensions,
      pid: process.pid,
      startedAt: startedAtIso,
      version: getNodeVersion(),
    });
  };

  // 1. Setup local Unix domain socket HTTP server (daemon control plane)
  let handleShutdown = async (): Promise<void> => {};
  const controlServer = createDaemonControlServer({
    dataDir,
    socketPath,
    startedAt,
    identity,
    ipcToken,
    isHubConnected: () => Boolean(rws && rws.readyState === ReconnectingWebSocket.OPEN),
    getHubRpc: () => hubRpc,
    syncRegistrationWithHub: () => syncRegistrationWithHub(),
    handleShutdown: () => handleShutdown(),
    getActiveExecCount: () => envRpcServer.getActiveExecCount?.() ?? 0,
  });

  await new Promise<void>((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(socketPath, () => {
      if (process.platform !== 'win32') {
        fs.chmod(socketPath, 0o600).catch(() => {});
      }
      fs.writeFile(pidFilePath, `${process.pid}\n`, { mode: 0o600 }).catch(() => {});
      // First start (no bind-retry window): the socket is now bound, so only
      // now tell the parent we are ready — a bind failure rejects the canary
      // instead of killing both daemons. (Replacements signaled earlier.)
      if (!isReplacementDaemon) {
        notifyDaemonReady();
      }
      resolve();
    });
  });

  // 2. Setup partysocket/ws ReconnectingWebSocket and birpc connection to Hub
  const wsUrl = identity.hubUrl.replace(/^http(s?):/, 'ws$1:') +
    `/ws/node?nodeId=${encodeURIComponent(identity.nodeId)}&token=${encodeURIComponent(identity.token)}`;

  rws = new ReconnectingWebSocket(wsUrl, [], {
    WebSocket: WsWebSocket as any,
    connectionTimeout: 10_000,
    minReconnectionDelay: Number(process.env.BOTD_WS_MIN_RECONNECT_DELAY_MS) || 200,
    maxRetries: Infinity,
  });

  let onRpcMessage: ((data: string) => void) | undefined;
  const createNodeRpc = () => createBirpc<HubRpcFunctions, NodeRpcFunctions>(
    {
      restartDaemon: async () => {
        // Prevent re-entry: throw if a restart is already in progress
        if (restartRequested) {
          throw new Error('Restart already in progress');
        }
        restartRequested = true;

        const logFile = process.env.BOTD_DAEMON_LOG || path.join(dataDir, 'daemon.log');
        let childPid: number;
        try {
          childPid = await spawnReplacementDaemon({
            dataDir,
            logFile,
            timeoutMs: 15_000,
          });
        } catch (err) {
          restartRequested = false;
          throw err;
        }

        setTimeout(() => {
          void handleShutdown();
        }, 100).unref();

        return { ok: true as const, pid: childPid };
      },
      checkUpgrade: async (opts) => {
        // Hub-RPC ingress: registry must be the official default or match
        // BOTD_NPM_REGISTRY; anything else the Hub sends is dropped.
        return await checkNodeUpgrade(dataDir, {
          ...opts,
          registryUrl: filterRpcRegistryUrl(opts?.registryUrl),
        });
      },
      upgradeDaemon: async (opts) => {
        // 排空保护：升级前等待在途 envExec（bash 命令）自然结束，避免拉起
        // 替换守护进程时杀死运行中的命令（最多等待 drainTimeoutMs）。
        return await performNodeUpgrade(dataDir, {
          ...opts,
          registryUrl: filterRpcRegistryUrl(opts?.registryUrl),
          getActiveTurnsCount: () => envRpcServer.getActiveExecCount?.() ?? 0,
          onScheduleShutdown: () => {
            setTimeout(() => {
              void handleShutdown();
            }, 100);
          },
        });
      },
      getCommands: async (botId) => {
        // Phase 3A：回合与命令已内联到 Hub Durable Runtime；Node 不再编排回合。
        assertSafeId(botId, 'Bot ID');
        const data = await readBot(dataDir, botId);
        if (!data || data.bot.nodeId !== identity.nodeId) throw new Error(`Bot "${botId}" not found on node`);
        return [];
      },
      saveBot: async (bot, systemMd) => {
        if (bot.nodeId !== identity.nodeId) {
          throw new Error(`Cannot save bot belonging to node "${bot.nodeId}" on node "${identity.nodeId}"`);
        }
        await saveBot(dataDir, bot, systemMd);
      },
      deleteBot: async (botId) => {
        await deleteBot(dataDir, botId);
      },
      readFile: async (target) => {
        return await readFileTarget(dataDir, target as Parameters<typeof readFileTarget>[1]);
      },
      writeFile: async (target, content) => {
        await writeFileTarget(dataDir, target as Parameters<typeof writeFileTarget>[1], content);
      },
      installResource: async (input) => {
        return await installResourceToNode(dataDir, input);
      },
      readResourcePackage: async (target) => {
        return await readResourcePackageDir(dataDir, target);
      },
      deleteResource: async (target) => {
        await deleteResource(dataDir, target);
      },
      runTurn: async () => {
        // Phase 3A：回合执行已迁至 Hub Durable Runtime（Brain in Hub, Hands on Node）。
        // 保留协议占位，拒绝新的回合请求，历史调用方会收到明确错误。
        throw new Error('runTurn is no longer served by node: turns run in the Hub durable runtime');
      },
      cancelTurn: async () => {
        // 回合在 Hub 侧执行，取消由 Hub 直接处理；Node 无本地回合可取消。
      },
      resetSession: async () => {
        // 回合已迁至 Hub；Node 无本地会话文件可清理。
      },
      ...envRpcServer,
    },
    {
      post: (data) => {
        if (rws.readyState === ReconnectingWebSocket.OPEN) {
          rws.send(data);
        }
      },
      on: (callback) => { onRpcMessage = callback; },
      serialize: serializeRpcMessage,
      deserialize: JSON.parse,
      timeout: 30 * 60 * 1000,
    }
  );

  rws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : event.data?.toString();
    if (!raw || !onRpcMessage) return;
    try {
      onRpcMessage(raw);
    } catch {
      console.error('Malformed RPC packet');
    }
  });

  rws.addEventListener('open', async () => {
    if (isStopping) return;
    const connectedRpc = createNodeRpc();
    rpcInstance = connectedRpc;
    hubRpc = connectedRpc;

    try {
      await syncRegistrationWithHub(connectedRpc);

      if (isStopping || hubRpc !== connectedRpc) return;

      // Start heartbeat loop every 20 seconds
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(async () => {
        if (rws.readyState === ReconnectingWebSocket.OPEN && hubRpc) {
          try {
            await hubRpc.heartbeat(identity.nodeId);
          } catch {
            // Heartbeat failures will trigger socket reconnection
          }
        }
      }, 20_000);
    } catch (err) {
      console.error('Node registration failed:', err);
    }
  });

  const onDisconnected = async () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    hubRpc = null;
    rpcInstance?.$close();
    rpcInstance = null;
    onRpcMessage = undefined;
  };

  rws.addEventListener('close', () => {
    void onDisconnected();
  });

  rws.addEventListener('error', (err: any) => {
    console.error('Node WebSocket error:', err.message || err);
  });

  const close = async () => {
    if (isStopping) return;
    isStopping = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (rpcInstance) {
      try {
        rpcInstance.$close();
      } catch {
        // ignore close errors
      }
    }

    await envRpcServer.envCleanup().catch(() => undefined);

    try {
      rws.close();
    } catch {
      // ignore close errors
    }

    await new Promise<void>((resolve) => {
      controlServer.close(() => resolve());
    });

    await fs.unlink(pidFilePath).catch(() => {});
    if (process.platform !== 'win32') {
      await fs.unlink(socketPath).catch(() => {});
    }
  };

  handleShutdown = async () => {
    try {
      await close();
    } catch {
      // ignore shutdown errors
    }
    process.exit(0);
  };

  return {
    nodeId: identity.nodeId,
    hubUrl: identity.hubUrl,
    socketPath,
    dataDir,
    close,
  };
}
