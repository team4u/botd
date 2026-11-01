# Pi provider reuse implementation contract

User requests full Pi SDK provider/model/auth reuse; current UI hardcodes five providers despite inference already using SDK. Replace hardcoded lists with real SDK metadata and reuse native ModelRuntime.login/getAuth for credentials. Preserve current live node/session and isolated data (never ~/.pi).

Parent owns packages/protocol, packages/models, apps/hub, tests and final integration. Node agent owns apps/node/**; Web agent owns apps/web/**. No installs by agents; parent handles workspace install/build. Do not change another scope. Shared DTOs have been added to packages/protocol/src/index.ts. @botd/models package exports buildModelCatalog(providers: readonly PiAI Provider[]) and getBuiltinModelCatalog(). Its providers and auth methods come directly from @earendil-works/pi-ai/providers/all and its model lists, with explicit public projection (no keys/headers). Use exact SDK1.4.0 dependencies.

## HTTP routes implemented by parent

All authenticated admin HTTP API, JSON values directly; errors {error}.

- GET /api/models/catalog: ModelCatalog from SDK builtins, configured status from global stored Key presence. ?nodeId=... delegates to that online Node RPC for its isolated/custom catalog + stored auth status. If node offline ->503. Web BOT editor should use selected node catalog and report load error; can fallback to builtin catalog visibly when unavailable and preserve existing custom provider/model fields.
- Existing GET/PUT /api/settings/models remains Record<providerId, key>, applies all providers, not just five.
- POST /api/nodes/:nodeId/providers/:providerId/login body {method:'api_key'|'oauth'} -> ProviderLoginState (must return immediately, never wait for interactive flow).
- GET /api/nodes/:nodeId/provider-logins/:loginId -> ProviderLoginState.
- POST /api/nodes/:nodeId/provider-logins/:loginId/respond body {promptId,value} -> ProviderLoginState.
- DELETE /api/nodes/:nodeId/provider-logins/:loginId -> {ok:true}.
- DELETE /api/nodes/:nodeId/providers/:providerId/auth -> {ok:true} removes Node SDK auth credential only, does not delete global Key (UI must distinguish).

## Node RPC additions

NodeRpcFunctions exact additions in protocol: getModelCatalog(), startProviderLogin({providerId,method}), getProviderLogin(loginId), respondProviderLogin({loginId,promptId,value}), cancelProviderLogin(loginId), logoutProvider(providerId). All use independent Node .agent/auth.json (SDK auth storage) and .agent/models.json (custom catalog), models-store.json there too. Model Key precedence: BOTD_API_KEY_PROVIDER > global models.json key > SDK stored credential. Do not consume ambient host Pi credentials. If no explicit Key nor SDK stored credential, fail clearly; do not silently use arbitrary provider env Keys. Additional provider config saved by native API-key login may include env fields (Cloudflare account, Azure resource etc.) in Node isolated auth store, and SDK handles validation/refresh.

Node generic Auth manager must call ModelRuntime.login(providerId,method,interaction,{agentName:'botd',getDeviceId:...stableid}) rather than implementing any provider auth itself. Native SDK AuthInteraction prompt/notify types are in apps/node/node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts. Support text/secret/select/manual_code prompts and info/auth_url/device_code/progress events, cancellation/TTL, prompt-specific AbortSignal (callback server can win while manual-code prompt pending). Return only nonsecret DTOs; never token/credential in RPC. Reject stale prompt replies via prompt id. Limit one active login per provider; reject invalid method before any network, jobs must not execute unauthorized arbitrary actions. Export a manager and optional runtime factory injection so parent can test generic interactions using a local fake provider without external OAuth accounts. Close login manager on daemon shutdown, prevent unfinished flows leaking. Metadata listing must not perform network auth probes or expose resolved secrets.

Runtime must stop requiring plaintext apiKey before ModelRuntime creation: allow isolated stored SDK OAuth/API credential too. Keep explicit env/global Key override via setRuntimeApiKey, use runtime.listCredentials() presence to ensure no ambient fallback, native SDK does actual auth and refresh. Use SDK's model (including custom registered catalog), no guess/fallback to invented endpoint. Preserve current session isolation, tools, wake env and cancellation behavior. Node may add botd login/logout CLI only if quick/useful, Web generic auth is the required flow.

## Web requirements

Settings: searchable full provider list from catalog, names/auth types/model counts; no manually written provider registry. Let users add/configure any built-in provider using global API key if supported; preserve arbitrary existing custom keys and allow custom provider IDs. Don't render hundreds of passwords at once; searchable provider select/sidebar plus selected provider form is good. Show configured filter/count if useful. API-key field and OAuth controls must match SDK authMethods metadata. Choose online Node for native auth login (API key interactive setup for extra fields, OAuth subscription etc.). Render safe external http(s) auth links, device user codes, generic prompt types and polling until success/error/cancel, support manual redirect URL/code pasted back, don't show tokens. Native logout and global key clearing separate. Do not claim all methods are real-account verified.

BOT editor: remove MODEL_PRESETS and fixed <option> list. Read catalog when selected node changes; searchable provider/model picker via native select+filter/datalist or an accessible combobox. Include full SDK models with actual ids, thinking and context metadata; support manual existing custom model ids while preserving draft changes under node polling. On provider change clear incompatible old model id/use first appropriate real model, not old unrelated id; do not change provider/model when asynchronous catalog arrives. Use meaningful Chinese labels, good empty/loading/error states, same styles/mobile usability as current UI. All Web API DTOs import protocol; SDK package only server-side (never ship provider internals/secrets/node SDK in browser).

Use npx pnpm@10.34.9 --filter @botd/node/@botd/web typecheck/build as applicable after parent confirms dependencies installed. Avoid broad doc recursion; relevant exact SDK declarations plus examples/sdk/12-full-control.ts suffice. Parent already read SDK docs/providers completely.
