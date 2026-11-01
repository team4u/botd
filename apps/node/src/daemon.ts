import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import fsSync, { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
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
  getDataDir,
  getBotDir,
  getDaemonSocketPath,
  listBots,
  listExtensions,
  listSkills,
  readFileTarget,
  readBot,
  readBotEnv,
  readNodeIdentity,
  saveBot,
  seedStorageIfEmpty,
  writeBotEnv,
  writeFileTarget,
} from './storage.js';
import { cancelAllBotTurns, cancelBotTurn, executeBotTurn, getBotCommands, resetBotSession } from './runtime.js';
import { getNodeModelCatalog } from './models.js';
import { ProviderAuthManager } from './provider-auth.js';
import { installResourceToNode } from './installer.js';
import { BgJobManager } from './bg-jobs.js';
import { ensureBuiltinSkill } from './builtin-skill.js';
import { ensureWindowsShell, isWindows } from './windows-shell.js';

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

const MAX_WAKE_BODY_BYTES = 64 * 1024;
const MAX_ARTIFACT_BODY_BYTES = 15 * 1024 * 1024;

function parseJsonBody<T = any>(
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
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
        resolve(null);
      }
    });

    req.on('end', () => {
      if (exceeded) return;
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        resolve(null);
      }
    });

    req.on('error', () => {
      resolve(null);
    });
  });
}

let restartRequested = false;

export async function startDaemon(dataDirOverride?: string): Promise<DaemonHandle> {
  const dataDir = getDataDir(dataDirOverride);
  await ensureDir(dataDir, 0o700);

  const identity = await readNodeIdentity(dataDir);
  if (!identity) {
    throw new Error(`Node is not paired. Run "botd join <hubUrl> --code <code> --name <name>" first.`);
  }

  await seedStorageIfEmpty(dataDir, identity.nodeId);
  await ensureBuiltinSkill(dataDir);

  // Windows needs a resolvable bash.exe for the Pi bash tool; resolve or
  // download a portable MinGit once before serving any traffic.
  if (isWindows) {
    await ensureWindowsShell(dataDir);
  }

  const socketPath = getDaemonSocketPath(dataDir);
  const pidFilePath = path.join(dataDir, 'daemon.pid');

  const bindRetryMs = Number(process.env.BOTD_DAEMON_BIND_RETRY_MS || '0');
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

  const authManager = new ProviderAuthManager(dataDir);

  const bgManager = new BgJobManager(dataDir, async (wakeInput) => {
    if (hubRpc && rws && rws.readyState === ReconnectingWebSocket.OPEN) {
      await hubRpc.requestWakeupTurn(wakeInput);
    }
  });

  let isStopping = false;
  let hubRpc: BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let rpcInstance: BirpcReturn<HubRpcFunctions, NodeRpcFunctions> | null = null;
  let rws: ReconnectingWebSocket;

  const syncRegistrationWithHub = async (targetRpc = hubRpc) => {
    if (isStopping || !targetRpc || !rws || rws.readyState !== ReconnectingWebSocket.OPEN) return;
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
    });
  };

  // 1. Setup local Unix domain socket HTTP server for wake requests
  let handleShutdown = async (): Promise<void> => {};
  const wakeServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        nodeId: identity.nodeId,
        name: identity.name,
        hubUrl: identity.hubUrl,
        dataDir,
        socketPath,
        logFile: process.env.BOTD_DAEMON_LOG || path.join(dataDir, 'daemon.log'),
        pid: process.pid,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        hubConnected: Boolean(rws && rws.readyState === ReconnectingWebSocket.OPEN),
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/shutdown') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setImmediate(() => { void handleShutdown(); });
      return;
    }

    if (req.method === 'POST' && req.url === '/reload') {
      req.resume();
      try {
        await syncRegistrationWithHub();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Reload failed' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/wake') {
      const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
      if (!payload) return;

      try {
        const { sessionId, botId, message, replyToBotId, noTurn, delaySeconds } = payload;
        if (
          typeof sessionId !== 'string' ||
          typeof botId !== 'string' ||
          typeof message !== 'string' ||
          !sessionId.trim() ||
          !botId.trim()
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid sessionId, botId, or message' }));
          return;
        }

        if (
          delaySeconds !== undefined &&
          !(typeof delaySeconds === 'number' && Number.isFinite(delaySeconds) && delaySeconds > 0)
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'delaySeconds must be a positive number' }));
          return;
        }

        assertSafeId(sessionId, 'Session ID');
        assertSafeId(botId, 'Bot ID');
        if (replyToBotId !== undefined) {
          assertSafeId(String(replyToBotId), 'Reply-To Bot ID');
        }

        if (!hubRpc || !rws || rws.readyState !== ReconnectingWebSocket.OPEN) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hub connection not established' }));
          return;
        }

        const wakeRes = await hubRpc.requestWakeupTurn({
          sessionId,
          botId,
          wakeupMessage: String(message),
          ...(replyToBotId ? { replyToBotId: String(replyToBotId) } : {}),
          ...(noTurn ? { noTurn: true } : {}),
          ...(delaySeconds ? { delaySeconds: Math.floor(delaySeconds) } : {}),
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...(wakeRes && typeof wakeRes === 'object' ? wakeRes : {}) }));
      } catch (err: any) {
        const statusCode = err.message?.includes('invalid') ? 400 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Wake request failed' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/bg/run') {
      const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
      if (!payload) return;

      try {
        const { sessionId, botId, command, replyToBotId, noTurnOnComplete } = payload;
        if (
          typeof sessionId !== 'string' ||
          typeof botId !== 'string' ||
          typeof command !== 'string' ||
          !sessionId.trim() ||
          !botId.trim() ||
          !command.trim()
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid sessionId, botId, or command' }));
          return;
        }

        const job = await bgManager.startJob({
          sessionId,
          botId,
          command,
          ...(replyToBotId ? { replyToBotId: String(replyToBotId) } : {}),
          ...(noTurnOnComplete ? { noTurnOnComplete: true } : {}),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job }));
      } catch (err: any) {
        const statusCode = err.message?.includes('invalid') ? 400 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to start background job' }));
      }
      return;
    }

    if (req.method === 'GET' && (req.url || '').startsWith('/bg/list')) {
      req.resume();
      try {
        const parsed = new URL(req.url || '/', 'http://localhost');
        const sessionId = parsed.searchParams.get('sessionId') || undefined;
        const botId = parsed.searchParams.get('botId') || undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobs: bgManager.listJobs({ sessionId, botId }) }));
      } catch (err: any) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to list background jobs' }));
      }
      return;
    }

    if (req.method === 'GET' && (req.url || '').startsWith('/bg/logs')) {
      req.resume();
      try {
        const parsed = new URL(req.url || '/', 'http://localhost');
        const jobId = parsed.searchParams.get('jobId') || '';
        const lines = Number(parsed.searchParams.get('lines')) || 100;
        if (!jobId.trim()) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid jobId' }));
          return;
        }
        const result = await bgManager.getJobLogs(jobId, lines);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err: any) {
        const statusCode = err.message?.includes('not found') ? 404 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to read background job logs' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/bg/kill') {
      const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
      if (!payload) return;

      try {
        const { jobId } = payload;
        if (typeof jobId !== 'string' || !jobId.trim()) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid jobId' }));
          return;
        }
        const job = await bgManager.killJob(jobId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job }));
      } catch (err: any) {
        const statusCode = err.message?.includes('not found') ? 404 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to kill background job' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/ask') {
      const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
      if (!payload) return;

      try {
        const { sessionId, botId, prompt, options, timeoutSeconds } = payload;
        if (
          typeof sessionId !== 'string' ||
          typeof botId !== 'string' ||
          typeof prompt !== 'string' ||
          !sessionId.trim() ||
          !botId.trim() ||
          !prompt.trim()
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid sessionId, botId, or prompt' }));
          return;
        }

        assertSafeId(sessionId, 'Session ID');
        assertSafeId(botId, 'Bot ID');

        if (!hubRpc || !rws || rws.readyState !== ReconnectingWebSocket.OPEN) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hub connection not established' }));
          return;
        }

        const result = await hubRpc.requestHumanInput({
          sessionId,
          botId,
          prompt: String(prompt),
          ...(Array.isArray(options) ? { options: options.map(String) } : {}),
          ...(typeof timeoutSeconds === 'number' && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, answer: result.answer }));
      } catch (err: any) {
        const statusCode = err.message?.includes('invalid') ? 400 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Ask request failed' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/artifact/put') {
      const payload = await parseJsonBody(req, res, MAX_ARTIFACT_BODY_BYTES);
      if (!payload) return;

      try {
        const { sessionId, botId, filePath, message, mimeType } = payload;
        let { filename, contentBase64 } = payload;

        if (typeof sessionId !== 'string' || !sessionId.trim()) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid sessionId' }));
          return;
        }

        assertSafeId(sessionId, 'Session ID');
        if (botId) {
          assertSafeId(String(botId), 'Bot ID');
        }

        if (filePath && !contentBase64) {
          const resolvedPath = path.resolve(String(filePath));
          const fileBuf = await fs.readFile(resolvedPath);
          contentBase64 = fileBuf.toString('base64');
          if (!filename) {
            filename = path.basename(resolvedPath);
          }
        }

        if (typeof filename !== 'string' || !filename.trim() || typeof contentBase64 !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing filename or contentBase64' }));
          return;
        }

        if (!hubRpc || !rws || rws.readyState !== ReconnectingWebSocket.OPEN) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hub connection not established' }));
          return;
        }

        const artifact = await hubRpc.uploadArtifact({
          sessionId,
          ...(botId ? { botId: String(botId) } : {}),
          filename: String(filename),
          ...(mimeType ? { mimeType: String(mimeType) } : {}),
          contentBase64: String(contentBase64),
          ...(message ? { message: String(message) } : {}),
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, artifact, ...artifact }));
      } catch (err: any) {
        const statusCode = err.message?.includes('invalid') ? 400 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Artifact upload failed' }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/artifact/pull') {
      const payload = await parseJsonBody(req, res, MAX_WAKE_BODY_BYTES);
      if (!payload) return;

      try {
        const { artifactId, outputPath } = payload;
        if (typeof artifactId !== 'string' || !artifactId.trim()) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid artifactId' }));
          return;
        }

        if (!hubRpc || !rws || rws.readyState !== ReconnectingWebSocket.OPEN) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hub connection not established' }));
          return;
        }

        const result = await hubRpc.downloadArtifact(String(artifactId));
        let savedTo: string | undefined;
        if (outputPath) {
          savedTo = path.resolve(String(outputPath));
          await ensureDir(path.dirname(savedTo));
          await fs.writeFile(savedTo, Buffer.from(result.contentBase64, 'base64'));
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          artifact: result.artifact,
          ...result.artifact,
          ...(savedTo ? { savedTo } : { contentBase64: result.contentBase64 }),
        }));
      } catch (err: any) {
        const statusCode = err.message?.includes('invalid') ? 400 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Artifact download failed' }));
      }
      return;
    }

    const reqUrl = req.url || '/';
    if (req.method === 'GET' && reqUrl.startsWith('/artifact/list')) {
      req.resume();
      try {
        const parsed = new URL(reqUrl, 'http://localhost');
        const sessionId = parsed.searchParams.get('sessionId');
        if (!sessionId || !sessionId.trim()) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid sessionId' }));
          return;
        }

        assertSafeId(sessionId, 'Session ID');

        if (!hubRpc || !rws || rws.readyState !== ReconnectingWebSocket.OPEN) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Hub connection not established' }));
          return;
        }

        const artifacts = await hubRpc.listSessionArtifacts(sessionId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, artifacts }));
      } catch (err: any) {
        const statusCode = err.message?.includes('invalid') ? 400 : 500;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Artifact list failed' }));
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    wakeServer.once('error', reject);
    wakeServer.listen(socketPath, () => {
      if (process.platform !== 'win32') {
        fs.chmod(socketPath, 0o600).catch(() => {});
      }
      fs.writeFile(pidFilePath, `${process.pid}\n`, { mode: 0o600 }).catch(() => {});
      resolve();
    });
  });

  // 2. Setup partysocket/ws ReconnectingWebSocket and birpc connection to Hub
  const wsUrl = identity.hubUrl.replace(/^http(s?):/, 'ws$1:') +
    `/ws/node?nodeId=${encodeURIComponent(identity.nodeId)}&token=${encodeURIComponent(identity.token)}`;

  rws = new ReconnectingWebSocket(wsUrl, [], {
    WebSocket: WsWebSocket as any,
    connectionTimeout: 10_000,
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
        const out = fsSync.openSync(logFile, 'a');
        let childPid: number | undefined;
        try {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: ['ignore', out, out],
            windowsHide: true,
            env: {
              ...process.env,
              BOTD_DAEMON_DETACHED: '1',
              BOTD_DAEMON_LOG: logFile,
              BOTD_DAEMON_BIND_RETRY_MS: '20000',
            },
          });
          child.unref();
          childPid = child.pid;
        } catch (err) {
          restartRequested = false;
          throw err;
        } finally {
          fsSync.closeSync(out);
        }

        if (typeof childPid !== 'number') {
          restartRequested = false;
          throw new Error('Failed to spawn replacement daemon');
        }

        setTimeout(() => {
          void handleShutdown();
        }, 800).unref();

        return { ok: true as const, pid: childPid };
      },
      getCommands: async (botId) => {
        assertSafeId(botId, 'Bot ID');
        const data = await readBot(dataDir, botId);
        if (!data || data.bot.nodeId !== identity.nodeId) throw new Error(`Bot "${botId}" not found on node`);
        return await getBotCommands(dataDir, data.bot);
      },
      getModelCatalog: async () => {
        return await getNodeModelCatalog(dataDir);
      },
      startProviderLogin: async (input) => {
        return await authManager.start(input);
      },
      getProviderLogin: async (loginId) => {
        return await authManager.get(loginId);
      },
      respondProviderLogin: async (input) => {
        return await authManager.respond(input);
      },
      cancelProviderLogin: async (loginId) => {
        await authManager.cancel(loginId);
      },
      logoutProvider: async (providerId) => {
        await authManager.logout(providerId);
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
      getBotEnv: async (botId) => {
        return await readBotEnv(dataDir, botId);
      },
      setBotEnv: async (botId, env) => {
        return await writeBotEnv(dataDir, botId, env);
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
      deleteResource: async (target) => {
        await deleteResource(dataDir, target);
      },
      runTurn: async (input) => {
        if (!hubRpc) throw new Error('Hub RPC not available');
        const bots = await listBots(dataDir);
        const bot = bots.find((b) => b.id === input.botId);
        if (!bot) {
          throw new Error(`Bot "${input.botId}" not found on node`);
        }
        return await executeBotTurn(dataDir, bot, input, hubRpc);
      },
      cancelTurn: async (sessionId, botId) => {
        await cancelBotTurn(sessionId, botId);
      },
      resetSession: async (sessionId, botId) => {
        const bots = await listBots(dataDir);
        const bot = bots.find((b) => b.id === botId);
        if (!bot) {
          throw new Error(`Bot "${botId}" not found on node`);
        }
        await resetBotSession(dataDir, sessionId, botId);
      },
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
    // Cancel active turns so they don't hang if disconnected from Hub
    await cancelAllBotTurns(dataDir).catch(() => {});
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
    hubRpc = null;

    restartRequested = false;
    await authManager.close();

    if (rpcInstance) {
      try {
        rpcInstance.$close();
      } catch {
        // ignore close errors
      }
    }

    await cancelAllBotTurns(dataDir).catch(() => {});
    await bgManager.closeAll().catch(() => {});

    try {
      rws.close();
    } catch {
      // ignore close errors
    }

    await new Promise<void>((resolve) => {
      wakeServer.close(() => resolve());
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
