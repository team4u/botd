import net from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
import {
  cancelAllBotTurns,
  cancelBotTurn,
  ensureBotdBinWrapper,
  executeBotTurn,
  getBotCommands,
  resetBotSession,
} from './runtime.js';
import { createLocalIpcServer } from './local-ipc.js';
import { getNodeModelCatalog } from './models.js';
import { ProviderAuthManager } from './provider-auth.js';
import { installResourceToNode } from './installer.js';
import { BgJobManager } from './bg-jobs.js';
import { ensureBuiltinSkill } from './builtin-skill.js';
import { ensureWindowsShell, isWindows } from './windows-shell.js';
import { notifyDaemonReady, spawnReplacementDaemon } from './daemon-launch.js';

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
  await ensureBotdBinWrapper(dataDir);

  // Windows needs a resolvable bash.exe for the Pi bash tool; resolve or
  // download a portable MinGit once before serving any traffic.
  if (isWindows) {
    await ensureWindowsShell(dataDir);
  }

  notifyDaemonReady();

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
  const wakeServer = createLocalIpcServer({
    identity,
    dataDir,
    socketPath,
    startedAt,
    isHubConnected: () => Boolean(rws && rws.readyState === ReconnectingWebSocket.OPEN),
    getHubRpc: () => hubRpc,
    bgManager,
    syncRegistrationWithHub: () => syncRegistrationWithHub(),
    handleShutdown: () => handleShutdown(),
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
      getBotEnv: (botId) => readBotEnv(dataDir, botId),
      setBotEnv: (botId, env) => writeBotEnv(dataDir, botId, env),
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
      listBgJobs: async (filter) => {
        return bgManager.listJobs(filter);
      },
      getBgJobLogs: async (jobId, tailLines) => {
        return await bgManager.getJobLogs(jobId, tailLines ?? 100);
      },
      killBgJob: async (jobId) => {
        return await bgManager.killJob(jobId);
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
