# Implementation coordination

Design source: docs/design.md (user supplied v2.2). This is a fresh pnpm monorepo using Node >=24.12, TS strict NodeNext, Pi SDK 1.4.0. Read the design before implementing. Write complete usable functionality, no TODO placeholders. Main agent owns root/protocol/tests; AGY agents own their application scopes. Do not edit another agent's scope or run install.

## Shared HTTP contract
- API paths in design, cookie auth on /api except POST /api/auth/login and POST /api/nodes/pairing/exchange; GET /api/health public. POST /api/auth/logout optional, GET /api/auth/me useful.
- Success responses return JSON values directly, not envelopes. Errors `{ error: string }` with suitable HTTP status.
- Login input `{ password }`, response `{ ok: true }` + HttpOnly SameSite=Strict cookie.
- GET /api/nodes returns NodeWithBots[] (NodeRecord plus bots[]).
- GET/PUT /api/settings/models: Record<string,string>; PUT body is that record; update pushed to online nodes.
- POST /api/nodes/pairing: `{ code, expiresAt }` (6 digits, TTL 10min, one time). exchange input `{code,name,platform}`, result `{nodeId,token}`.
- POST /api/bots and PUT /api/bots/:botId input: BotConfig fields except updatedAt plus systemMd. Result BotConfig. Optional GET /api/bots/:botId/system returns `{content}`; PUT same shape. All system/memory/skill reads return `{ content: string }`, writes take `{content}` and return `{ok:true}`. BOT updates may fetch system first to preserve it.
- GET /api/sessions returns SessionRecord[]. POST takes CreateSessionInput returns SessionRecord. PATCH accepts title/mode/leadBotId/memberBotIds.
- GET /api/sessions/:id/messages returns MessageRecord[]. POST input `{content}` returns stored user MessageRecord immediately (202) and starts queue in background.
- POST /api/sessions/:id/cancel returns `{ok:true}`. SSE uses default message events `data: JSON.stringify(SessionSseEvent)`, initial status + keepalives; support reconnect with history reload. Never cache authenticated API data in service worker.

## RPC and runtime contract
- packages/protocol exports exact supplied shared types. Never independently duplicate them.
- birpc JSON transport over ws. Both ends use serialize JSON.stringify, deserialize JSON.parse and normal default birpc method mode; events use `.asEvent`. Timeout at least 30 minutes for inference, heartbeat every 20s.
- Node WebSocket URL /ws/node?nodeId=...&token=..., authenticate before upgrade, bind methods to authenticated node identity. Hub rejects impersonation of other node/bot/session.
- Hub entry exports `createHub(options?: { dbPath?: string; adminPassword?: string; webDir?: string })` returning `{ app, db, connections, router, close }`. `app` is Hono, `db` a data-store wrapper, connections is connection manager. Also export `startHub(options?: {port?:number;host?:string;dbPath?:string;adminPassword?:string;webDir?:string})` returning above + server and resolved port. Must not bind on module import; CLI direct execution only. Main tests exercise HTTP + real ws RPC mocks.
- Hub default port 3000, web Vite dev 5173 proxies /api and /ws to 127.0.0.1:3000. Production Hub serves apps/web/dist incl SPA fallback.
- Route scheduler must serialize each session, bound @ relay chains and avoid resetting shared loop counter allowing infinite relay. Queue items can carry per-chain relay budgets. Use monotonic DB row sequence for cursors so same timestamp messages aren't dropped. On failure emit failed status + public system error message, stop pending chain; cancel reliably drops queue, suppresses late replies/relays. Separate sessions may run concurrently.
- Node uses BOTD_DATA_DIR / --data-dir; root ~/.botd. node.json 0600, safe IDs only [A-Za-z0-9_-]+, no path escape incl session IDs. No global process.env mutations per-turn: use per-session custom bash environment/hook for BOTD_SESSION_ID/BOTD_BOT_ID/BOTD_DATA_DIR, allow concurrent sessions without leaking identity.
- Pi SDK 1.4.0 differs from original blueprint. Official docs at /root/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md and examples/sdk/12-full-control.ts. Use createAgentSession + custom ResourceLoader, in-memory settings, explicit ModelRuntime paths under dataDir and explicit model, SDK auth env fallback disabled if possible (only BOTD_API_KEY_PROVIDER and node-local .agent credentials). No discovery ~/.pi or ancestor .pi or arbitrary skills/extensions/context. Build role+memory+enabled-skills into system prompt. Use session file per bot+session and private tool logs; only public final response to Hub. Missing key/model and model errors must surface as failed turn, not placeholder reply.
- Node package @botd/node bin botd -> dist/cli.js; scripts cli `tsx src/cli.ts`, dev `tsx src/cli.ts start`, build tsc. Hub @botd/hub dev `tsx watch src/index.ts`, start `node dist/index.js`, build tsc. All apps have typecheck.
- Node daemon exports startDaemon(dataDir) returning shutdown handle if practical. Runtime executeBotTurn + cancelBotTurn and isolated storage helpers can be exported for tests. CLI join/start/wake; no host .pi reads. Default BOT + useful example skill on first start. No automatic pairing without a pairing code.
- Web React+Vite, lucide-react, react-markdown, Tailwind dependency; responsive PWA manifest/icons/service worker. Include all management flows, real API, error/loading/empty states, accessible labels. Light coherent polished UI preferred. No fake data.
