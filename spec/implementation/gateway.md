*The gateway is the component that talks to AI model providers. Everything
else in Pino uses models by asking the gateway, so credentials and provider
complexity live in exactly one place.*

# Gateway

Authoritative for the gateway component: cardinality, storage, catalog
policy, and the binding rules of the v0 implementation. The wire it serves
is owned by [[inference.md]].

One gateway runs per machine, shared by all runners; singularity is enforced
by the singleton rule in [[storage.md]]. It owns the provider registry, the
model catalog, credential storage, and the execution of model requests.
Credentials never leave the gateway outbound; the one inbound crossing is
API-key entry during `login` — which is why the wire is a same-user local
socket ([[storage.md]]). The gateway never acts on a tool call; it is data
in the response, and acting on it is the caller's business.

## Methods

The gateway serves the inference schema; [[inference.md]] owns every
method's shapes and rules. For orientation:

- `initialize` — the transport handshake ([[design/transport.md]])
- `listModels` — the model catalog
- `respond` — send a conversation; the response streams back as
  `respondEvent` notifications; `cancel` aborts
- `authStatus` / `login` / `logout` — credential management; during
  `login` the gateway drives the caller with `authPrompt` requests and
  `authEvent` notifications

Ambient credentials (environment variables) need no wire interaction; the
auth methods exist for everything better than env vars.

## Storage

The gateway owns `$PINO_STATE_DIR/gateway/` ([[storage.md]]) and persists
exactly one file:

- **`auth.json`** — credentials, keyed by provider id, one type-tagged
  credential per provider: `{"type":"api_key","key":…}` (optionally with an
  `env` object of provider-scoped values) or
  `{"type":"oauth","access":…,"refresh":…,"expires":…}`. This is pi-ai's
  `Credential` shape (its docs call it "the shape of today's auth.json")
  and Pi's own credentials file format.

The gateway is the file's only writer — write serialization is the process
model, licensed by the singleton rule — with no cross-process locking,
unlike Pi, whose N independent processes must lock a shared auth.json. Not
stored: dynamic model lists (in-memory) and anything session- or
usage-shaped (other components' domains).

## Catalog

The catalog and auth resolution are implementation-defined data: the
schemas bind their *shapes* ([[inference.md]]), not their values — which
models exist, which providers resolve as configured, and from what sources
are the implementation's to define. The v0 implementation adopts pi-ai's
stock catalog and auth resolution wholesale. Custom provider and model
definitions are deferred.

## Operations

The v0 implementation is a TypeScript project at `packages/gateway`,
building to `dist/index.js`, run with `npm run start` for testing; it depends
on the shared `transport` and `storage` packages ([[implementation/index.md]]). How
components are launched in an installed Pino (executables, dispatch,
implementation overrides) is deliberately unspecified for now.

## V0 implementation

Binding rules for the v0 wrap; pi-ai internals and the investigation behind
these rules live in `docs/pi-ai-report.md` (non-binding).

- The pi-ai dependency is pinned exactly: `@earendil-works/pi-ai@0.80.6`.
  [[inference.md]]'s shapes are vendored from it, so version bumps are
  deliberate changes reviewed against both specs. pi-ai's deprecated
  `/compat` surface is not used.
- Every model request runs with an abort signal honoring `cancel` and
  connection drop, and an explicit retry bound (pi-ai's Anthropic
  implementation performs no retries by default, its documentation
  notwithstanding).
- Stream outcomes map exactly: terminal success → the `respond` result;
  terminal failure → wire error `response_failed` or `aborted` with the
  partial message as error data. pi-ai streams never throw; this mapping is
  the only failure path.
- Failed turns are logged to stderr — error message and diagnostics — with
  request bodies never logged and known secret patterns redacted. A durable
  log location is future work.
- Wire traffic carries schema shapes only: pi-ai's stream events reduce to
  the vendored event union (the same translation pi's own proxy performs),
  and non-schema fields such as per-message diagnostics are stripped.
- `gateway/auth.json` is written with file mode 0600 in its 0700 directory;
  writes serialize in-process, and OAuth token refresh serializes with them
  so concurrent requests cannot double-refresh.
- `login` bridges pi-ai's two flow callbacks to the wire (question →
  `authPrompt`, announcement → `authEvent`); a completed flow persists
  the credential. The manual paste path is canonical ([[inference.md]]);
  pi-ai's loopback callback listener may incidentally complete a
  same-machine flow, which is acceptable.

## Test assertions

Shapes per [[spec-policy.md#^test-shapes]]. The wire methods this gateway
serves are proven in [[inference.md]]; the assertions here cover what the
gateway owns beyond the schema — catalog identity, credential storage, and the
V0 binding rules. The version pin and `/compat` abstention are **Guards**:
static tripwires that fail loudly on a silent change, not behavioral authority.

- **Contract** (real builtin catalog vs pi-ai stock): the gateway catalog
  equals pi-ai's independently-built stock catalog by identity — same provider
  set and cardinality, same per-provider model set, same per-provider auth
  surface (which methods resolve) — compared on ids only, never display text;
  the anthropic slice is a well-formed, non-empty model catalog.
  ^t-gateway-catalog
- **Seam** (real spawned gateway over its socket): the real gateway process
  serves `listModels` (entries carrying exactly the schema subset) and
  `authStatus` over its Unix socket under a scrubbed env, and still answers
  `-32601` for unknown methods. ^t-gateway-e2e
- **Contract** (credential store, real fs): `auth.json` is a top-level object
  keyed by provider id with type-tagged values, written `0600` in a `0700`
  directory (pre-existing loose modes corrected, a leftover tmp consumed);
  read/modify/delete round-trip; a corrupt or non-object document is surfaced
  as an error naming the file and never clobbered; a `modify` whose fn rejects
  writes nothing and does not wedge the serialization queue.
  ^t-gateway-cred-store
- **Seam** (real store + real `Models.getAuth`, scripted refresh, real socket):
  two concurrent responds seeing one expired OAuth token refresh it exactly once
  and both proceed on the rotated credential, persisted exactly once with no
  lost update — the refresh serialized with the store's in-process writes.
  ^t-gateway-oauth-refresh
- **Contract** (redaction, unit + scripted failed turn): the redactor replaces
  `sk-`-shaped keys and secret env/extra values (stored-credential tokens
  collected by the store, including non-`sk-` shapes), every occurrence, above a
  minimum-length floor; and on a real failed turn both the single logged line
  and the outbound wire error — its `message` and the `partialMessage.errorMessage`
  in its data — are redacted, the request body is never logged, and a successful
  turn logs nothing. ^t-gateway-redact
- **Guard** (static — source tree and manifest): `@earendil-works/pi-ai` is
  pinned exactly at the vendored version (no `^`/`~`), and no gateway source
  imports pi-ai's deprecated `/compat` surface. ^t-gateway-guards
