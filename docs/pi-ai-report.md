# pi-ai investigation report (0.80.6, July 2026)

Reference, not authority: findings from the deep dive that produced
`spec/inference.md` and `spec/gateway.md`'s v0 implementation rules. Facts
here describe `@earendil-works/pi-ai@0.80.6` and may rot with upstream
changes; the specs bind, this file explains.

## API landscape

pi-ai ships two parallel surfaces: the current API (`createModels`,
`createProvider`, `builtinModels`, `CredentialStore`) and a deprecated
`/compat` global registry whose own header says it is "deleted with the
coding-agent ModelManager migration." pi-coding-agent 0.80.6 still runs
entirely on compat — grep finds zero use of the current API in it. Pino
wraps the current API and is therefore slightly ahead of the reference
consumer.

`builtinModels()` registers all 35 stock chat providers. All stock catalogs
are static (baked into generated files; no shipped provider implements
`refreshModels`); catalog updates arrive only via package versions.

## Streaming runtime

- `streamSimple`/`completeSimple` are the portable calls; `stream`/`complete`
  take per-API option types (Anthropic: `thinkingEnabled`, `effort`, …) and
  require narrowing. `complete*` is literally `stream*().result()`.
- `EventStream` is a single-consumer async iterable plus a `result()`
  promise that resolves on the terminal event — in **both** success and
  failure. Errors never throw out of stream functions; auth failures
  included. A wrapper must branch on `stopReason`, not try/catch.
- Event ordering guarantees are minimal: `start` first, one terminal
  `done`/`error` last; blocks are **not** contiguous (associate deltas by
  `contentIndex`); providers may emit a single `toolcall_delta` carrying
  complete arguments.
- `maxRetries`: documented as "SDK default 2" but the Anthropic
  implementation passes `?? 0` — no retries unless set. `maxRetryDelayMs`
  defaults to 60s and caps server-requested backoff.
- Prompt caching: `cacheRetention` (`"short"` default; `"long"` → Anthropic
  1h `cache_control`, billed 2× base input on writes) with automatic marker
  placement; `sessionId` feeds cache-affinity headers where supported.
- Cost is computed per turn by `calculateCost` ($/million-token rates on
  each model record, request-wide pricing tiers), mutating `usage.cost`.

## Wire precedent

`pi-agent-core`'s `proxy.ts` defines `ProxyAssistantMessageEvent` — pi's own
wire form of the stream events, with the per-event `partial` snapshot
stripped, `id`/`toolName` lifted into `toolcall_start`, and terminal events
reduced to usage. `spec/inference.md` vendors this union for
`respond_event`, deviating only in carrying the full final message in the
`respond` result (pi's proxy sends usage only and clients reconstruct).

## Auth

- Providers declare `ProviderAuth = {apiKey?, oauth?}`. OAuth-capable stock
  providers: Anthropic (Claude Pro/Max; authorization-code + PKCE), GitHub
  Copilot (device code), OpenAI Codex (browser or device code).
- Flows are UI-agnostic, driven by two callbacks — `prompt(AuthPrompt) →
  Promise<string>` and `notify(AuthEvent)` — which map one-to-one onto the
  wire's `auth_prompt`/`auth_event`. pi-ai does not open browsers; the
  Anthropic flow starts a loopback callback server (`127.0.0.1:53692`) and
  races it against manual code paste. Token exchange bakes in a 5-minute
  early-expiry skew.
- pi-ai ships only an in-memory `CredentialStore`; the file-backed store is
  app-owned. Pi's (`AuthStorage` in pi-coding-agent) writes
  `~/.pi/agent/auth.json` with 0600/0700 modes and `proper-lockfile`
  cross-process locking — machinery Pino's singleton gateway does not need.
- Env-var resolution (`findEnvKeys`/`getEnvApiKey`) maps providers to keys
  (`ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) and
  treats AWS Bedrock and GCP Vertex ambient credentials as configured.

## Deferred: models.json

Custom provider/model definitions (`models.json`, with `$ENV` interpolation
and `!command` execution in values) are parsed by pi-coding-agent, not
pi-ai — not importable across that boundary. When Pino adds custom
providers, a small reimplementation of the parser and value resolver is
required (reference: `core/model-registry.js`,
`core/resolve-config-value.js` in pi-coding-agent; note `!command` is
arbitrary command execution from user-owned config). Deferred from v0 along
with the `gateway/models.json` file itself.
