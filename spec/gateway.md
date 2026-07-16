*The gateway is the component that talks to AI model providers. Everything
else in Pino uses models by asking the gateway, so credentials and provider
complexity live in exactly one place.*

# Gateway

One gateway runs per machine, shared by all runners. It owns: the provider
registry and model catalog; credential storage and auth resolution
(credentials never cross the wire); and executing model requests — a caller
sends a conversation, and the gateway streams back the model's response in
provider-neutral form: an assistant message that may contain text, thinking,
and tool-call requests. The gateway never acts on a tool call; it is data in
the response, and acting on it is the caller's business. It serves the
inference schema; v0 wraps `pi-ai` (pinned) as its implementation.

## Methods

The v0 surface of the inference schema, listed here as capabilities; message
shapes are formalized in the inference schema spec.

- **`initialize`** — the transport handshake ([[transport.md]]); first
  request on every connection.
- **`list_models`** — returns the model catalog: model ids plus
  caller-relevant metadata. No parameters in v0.
- **`respond`** — the core operation. Request carries a model id and a
  conversation; the model's response streams back as notifications (text,
  thinking, and tool-call deltas), terminated by the result carrying the
  final assistant message, stop reason, and usage. Correlation of the
  stream to its request is a schema-defined params field.
- **`cancel`** — notification: abort an in-flight `respond`. The canceled
  request still terminates with its response (error or partial result), so
  every request keeps exactly one terminator. Backstop: a dropped
  connection aborts everything in flight on it — a crashed caller never
  leaves the gateway streaming to nobody.
- **`auth_status`** — per provider: configured or not, and the source label
  for status display ("OAuth", "ANTHROPIC_API_KEY").
- **`login`** — starts a provider's interactive auth flow (API-key entry or
  OAuth), run by the gateway. During the flow the gateway drives the client
  via `auth_prompt` and `auth_event` (below); the `login` request resolves
  when the flow completes. Credentials land in the gateway's credential
  store and never cross the wire — the client only relays user input.
- **`logout`** — delete a provider's stored credential.

Gateway → client, during a `login` the client initiated:

- **`auth_prompt`** — request: the gateway asks the user something through
  the client and awaits the answer in the response — secret entry (API
  key), option select, or paste-code. Prompt kinds are vendored from
  pi-ai's `AuthPrompt` shapes.
- **`auth_event`** — notification: user-facing flow events to display — an
  auth URL to open, a device code, progress text. Vendored from pi-ai's
  `AuthEvent` shapes.

A client that never calls `login` need not implement either: per
[[transport.md]] compatibility rules, an unimplemented `auth_prompt` gets
`method not found`, which fails the login cleanly.

## Storage

The gateway owns `$PINO_STATE_DIR/gateway/` ([[storage.md]]) and persists
exactly two files, both in shapes adopted from Pi:

- **`auth.json`** — credentials, keyed by provider id, one type-tagged
  credential per provider: `{"type":"api_key","key":…}` or
  `{"type":"oauth","access":…,"refresh":…,"expires":…}`, plus an optional
  `env` object for provider-scoped values. This is pi-ai's `Credential`
  shape (its docs call it "the shape of today's auth.json") and Pi's own
  credentials file format.
- **`models.json`** — optional custom provider and model definitions
  (custom `baseUrl`, headers, model lists), in Pi's `models.json` format,
  including its value syntax (`$ENV_VAR` interpolation, `!command`
  execution) for keeping secrets out of the file.

The gateway is the only writer of both. Because it is a per-machine
singleton, write serialization is the process model itself — no
cross-process file locking, unlike Pi, whose N independent processes must
lock a shared auth.json.

Not stored: dynamic model lists (in-memory, re-fetched from providers) and
anything session- or usage-shaped (other components' domains).

## Catalog

The model catalog is pi-ai's stock providers plus whatever `models.json`
defines: which models *exist* is stock ∪ custom; which are *usable* is
determined by auth resolution per provider.

## Operations

The v0 implementation is a TypeScript project at `packages/gateway`,
building to `dist/index.js`, run with `npm run start` for testing. How
components are launched in an installed Pino (executables, dispatch,
implementation overrides) is deliberately unspecified for now.

Credentials from ambient sources (environment variables such as
`ANTHROPIC_API_KEY`) work with no wire interaction at all; the auth methods
exist for everything better than env vars.
