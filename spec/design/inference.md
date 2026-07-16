*The messages spoken between a caller (usually a runner) and the gateway: how
to list models, send a conversation, stream back the model's response, and
run auth flows. This is the contract a gateway implementation in any language
must honor.*

# Inference schema

Authoritative for the inference wire: every message between a *caller* and
the gateway. Schema name `pino.inference`, version `1`, spoken over
[[design/transport.md]]. Served by the gateway ([[implementation/gateway.md]]).

Shapes below are vendored from pi-ai, at the version pinned in
[[implementation/gateway.md]] — its `Context`/`Message`/content types and its proxy wire
events — and are frozen here as Pino's contract; pi-ai evolving does not
change this schema. Optional fields are omitted when absent (never `null`);
timestamps are epoch milliseconds.

## Data shapes

**Model reference** — `{"provider": string, "id": string}`. Models are
unique per provider.

**Context** — the conversation sent to a model:

```
{systemPrompt?: string, messages: Message[], tools?: Tool[]}
```

**Message** — one of three roles:

```
{role: "user", content: string | (Text|Image)[], timestamp: number}

{role: "assistant", content: (Text|Thinking|ToolCall)[],
 api: string, provider: string, model: string,
 responseModel?: string, responseId?: string,
 usage: Usage, stopReason: StopReason, errorMessage?: string,
 timestamp: number}

{role: "toolResult", toolCallId: string, toolName: string,
 content: (Text|Image)[], details?: any, isError: boolean,
 timestamp: number}
```

`toolResult.details` must be JSON-serializable; it is carried verbatim.
The assistant shape is referenced below as *AssistantMessage*. pi-ai's
per-message `diagnostics` field is deliberately excluded: the gateway
strips it — and any other non-schema field — from everything it sends on
the wire.

**Content blocks:**

```
{type: "text",     text: string, textSignature?: string}
{type: "thinking", thinking: string, thinkingSignature?: string, redacted?: boolean}
{type: "image",    data: string, mimeType: string}          // data: base64
{type: "toolCall", id: string, name: string,
                   arguments: object, thoughtSignature?: string}
```

**Tool** — `{name: string, description: string, parameters: object}` where
`parameters` is a JSON Schema object.

**Usage** — token counts and cost, on every final assistant message:

```
{input: number, output: number, cacheRead: number, cacheWrite: number,
 cacheWrite1h?: number, reasoning?: number, totalTokens: number,
 cost: {input: number, output: number, cacheRead: number,
        cacheWrite: number, total: number}}
```

**StopReason** — `"stop" | "length" | "toolUse"` on success;
`"error" | "aborted"` on failure (failures arrive as errors, below).

## Methods: caller → gateway

### `initialize`

Per [[design/transport.md]]. `schema: "pino.inference"`, `version: 1`.

### `listModels`

Request, no params. Result:

```
{models: [{provider: string, id: string, name: string,
           reasoning: boolean, input: ("text"|"image")[],
           contextWindow: number, maxTokens: number}]}
```

The entry is a caller-relevant subset of the catalog's model record;
gateway-internal fields (base URLs, headers, compat flags) are deliberately
not exposed, and pricing is deferred — authoritative cost returns on every
response's `usage`.

### `respond`

Request. The core operation: send a context to a model, stream the response.

```
params: {model: {provider, id}, context: Context, options?: Options}
```

**Options** (all optional; a subset of the serializable options pi-ai's
own proxy protocol allows — the rest are deferred, addable within this
version per [[design/transport.md]] compatibility rules):

```
{temperature?: number, maxTokens?: number,
 reasoning?: "minimal"|"low"|"medium"|"high"|"xhigh"|"max",
 cacheRetention?: "none"|"short"|"long",   // default "short"
 sessionId?: string}   // provider-side cache key; unrelated to Pino sessions
```

While the request is open, the gateway streams `respondEvent`
notifications (below). The request terminates with either:

- **Result** — the turn completed (`stopReason` `stop`, `length`, or
  `toolUse`):

  ```
  {message: AssistantMessage}
  ```

  The result carries the full final assistant message, so a caller may
  ignore the event stream entirely and treat `respond` as request/response.
  (Deviation from pi-ai's proxy, which sends only usage and requires the
  client to reconstruct the message from deltas — completeness chosen over
  bandwidth; deltas remain available for callers that stream.)

- **Error** — the turn failed or was canceled (codes below), with
  `error.data`:

  ```
  {partialMessage?: AssistantMessage}
  ```

  The error code distinguishes failure from cancellation; `partialMessage`
  carries any content produced before the failure — its own `stopReason`
  and `errorMessage` included — with partial usage/cost, and may be pushed
  back into a context to continue an aborted turn.

Multiple `respond` requests may be in flight on one connection, with three
rules that keep correlation unambiguous:

- A caller must not reuse a request id while its connection is open; the
  gateway emits nothing for — and ignores `cancel` of — ids not currently
  in flight.
- The gateway sends every `respondEvent` for a request before that
  request's terminating response.
- A closed connection is an implicit terminator: the caller treats every
  request that was in flight on it as failed with `aborted`.

### `respondEvent` (gateway → caller, notification)

Streamed while a `respond` is open. `params.requestId` names the caller's
`respond` request id; `params.event` is one of (vendored verbatim from
pi-ai's proxy event union — the bandwidth-stripped wire form of its stream
events):

```
{type: "start"}
{type: "text_start",     contentIndex}
{type: "text_delta",     contentIndex, delta}
{type: "text_end",       contentIndex, contentSignature?}
{type: "thinking_start", contentIndex}
{type: "thinking_delta", contentIndex, delta}
{type: "thinking_end",   contentIndex, contentSignature?}
{type: "toolcall_start", contentIndex, id, toolName}
{type: "toolcall_delta", contentIndex, delta}      // partial JSON args
{type: "toolcall_end",   contentIndex}
```

Rules, inherited from pi-ai's stream contract: `start` is first; events for
different content blocks are **not** guaranteed contiguous — consumers must
associate deltas by `contentIndex`, never by adjacency; no particular
intermediate event is guaranteed (a provider may emit one `toolcall_delta`
carrying complete arguments). There are no terminal event types on the
wire: termination is the `respond` response itself.

### `cancel`

Notification. `params: {requestId}` — abort the in-flight `respond` with
that id. The canceled request still terminates, with error code `aborted`.
A dropped connection cancels all requests in flight on it.

### `authStatus`

Request, no params. Result:

```
{providers: [{provider: string, name: string,
              methods: ("api_key"|"oauth")[],
              configured: boolean, source?: string}]}
```

`source` is an opaque human-readable label naming where the credential
resolves from ("OAuth", "ANTHROPIC_API_KEY", "~/.aws/credentials");
callers must not parse it.

### `login`

Request. `params: {provider: string, method?: "api_key"|"oauth"}` — when
`method` is omitted and the provider supports several, the gateway asks via
an `authPrompt` select. During the flow the gateway drives the caller with
`authPrompt` and `authEvent` (below). Result:

```
{provider: string, source?: string}
```

Login flows are connection-scoped: prompts and events go only to the
connection that initiated the `login`, and at most one `login` may be in
flight per connection (a second is rejected with `login_failed`).
Connection close aborts the flow. Concurrent logins for one provider from
different connections are last-write-wins on the stored credential.

### `logout`

Request. `params: {provider: string}`. Deletes the stored credential;
ambient sources (environment variables) are unaffected. Result: `{}`.

## Methods: gateway → caller (during `login`)

### `authPrompt`

Request — a question. The response is the user's answer, `{value: string}`
(for `select`, the chosen option `id`), or `{cancelled: true}` when the
user declines:

```
{type: "text",        message, placeholder?}
{type: "secret",      message, placeholder?}     // e.g. API key entry
{type: "select",      message, options: [{id, label, description?}]}
{type: "manual_code", message, placeholder?}     // paste OAuth code
```

A prompt can become moot while pending (the flow resolved another way); the
signal is the `login` request itself resolving. The caller then dismisses
its UI and responds `{cancelled: true}`; the gateway ignores responses to
prompts whose flow has already moved on.

### `authEvent`

Notification — display-only flow information, nothing owed back:

```
{type: "auth_url",    url, instructions?}
{type: "device_code", userCode, verificationUri,
                      intervalSeconds?, expiresInSeconds?}
{type: "progress",    message}
```

Flows are manual by design: on `auth_url` the caller displays the URL, the
user opens it themselves and brings the resulting code back through a
`manual_code` prompt. Callers do not auto-open browsers.

## Errors

Application codes (positive, per [[design/transport.md]]):

| code | name                      | on                                    |
|------|---------------------------|---------------------------------------|
| 1    | `model_not_found`         | `respond` with unknown provider/model |
| 2    | `provider_not_configured` | `respond` without resolvable auth     |
| 3    | `response_failed`         | provider/network/validation failure   |
| 4    | `aborted`                 | canceled via `cancel` or disconnect   |
| 5    | `login_failed`            | auth flow failed, declined, or aborted |

`response_failed` and `aborted` carry the `respond` error data shape above.

## Test assertions

Shapes per [[spec-policy.md#^test-shapes]]. The methods are proven as
**Contract** with pi-ai scripted: a hand-rolled `ProviderStreams` or
`ProviderAuth` drives pi-ai's event/callback contract exactly, over a **real
caller↔gateway socket**, so permutation breadth — every event, error code, and
auth branch — lives here. The mocked boundary is gateway↔pi-ai; these Contracts
forfeit proof that a real pi-ai stream actually reduces to these shapes. That
crossing is the Seam at [[#^t-inference-real-pi-ai]].

- **Contract** (scripted providers): `listModels` returns exactly
  `{provider, id, name, reasoning, input, contextWindow, maxTokens}` per model
  — gateway-internal fields excluded — aggregated across providers.
  ^t-inference-list-models
- **Contract** (scripted stream): a `respond` streams the bandwidth-stripped
  `respondEvent` union in order (no `partial` snapshots, no terminal event
  types; signatures lifted onto `*_end`; `toolcall_start` lifting `id`/
  `toolName`), every event precedes the terminating response, and the result
  carries the full stripped final `AssistantMessage`; a string request id works
  end to end; an unknown content-block type and every non-schema field
  (diagnostics included) are dropped rather than reaching the wire.
  ^t-inference-respond-stream
- **Contract** (scripted terminals): terminal success → result; terminal
  failure → `response_failed` (3) with the stripped `partialMessage` (its own
  `stopReason`/`errorMessage`, partial usage), omitting `partialMessage` when
  nothing was produced; unknown provider/model → `model_not_found` (1);
  unresolvable or failing auth → `provider_not_configured` (2) — neither
  reaching the provider. ^t-inference-respond-errors
- **Contract** (scripted stream, cancellation): `cancel` of an in-flight
  `respond` aborts its gateway-owned signal and terminates it `aborted` (4) with
  the partial, leaving a concurrent `respond` untouched; a dropped connection
  aborts every `respond` in flight; `cancel` of an unknown, already-completed,
  or malformed id is ignored; a duplicate in-flight request id — even pipelined
  in one chunk — is `-32600` with the original untouched. ^t-inference-cancel
- **Contract** (scripted stream, options): the gateway hands pi-ai a
  gateway-owned abort signal and its own explicit finite retry bound, ignoring
  any caller-supplied `maxRetries`; the schema Options subset passes through and
  every non-schema option — including a wire-smuggled `apiKey` — is dropped, a
  non-object `options` treated as absent. ^t-inference-options
- **Contract** (scripted stream): the resolved credential handed to the
  provider appears in no event or result on the socket — credentials never
  cross the wire outbound. ^t-inference-no-cred-wire
- **Contract** (scripted providers, `authStatus`): each provider reports its
  `methods`, `configured`, and opaque `source`, resolved without network — a
  stored credential winning over ambient env, an expired stored OAuth still
  `configured` with no refresh triggered, an unrecognized or mismatched stored
  type `configured:false`, a throwing resolver degrading to `configured:false`
  and leaving the rest intact — reading `auth.json` once per call.
  ^t-inference-auth-status
- **Contract** (scripted auth flows): `login` drives the caller with
  `authPrompt` **requests** and `authEvent` **notifications** across their full
  unions (placeholder/description present-or-omitted), selects the method when
  several exist and none is named, persists only on success (with `source` per
  `authStatus`), and maps a failed, declined, or aborted flow to `login_failed`
  (5) without clobbering an existing credential; connection close aborts the
  flow via a flow-level signal, persisting nothing; at most one `login` runs per
  connection. ^t-inference-login
- **Contract** (scripted auth flows, scoping): prompts and events reach only
  the initiating connection; concurrent logins for one provider from different
  connections are last-write-wins; a prompt made moot by the flow resolving
  elsewhere, and a late duplicate response to a settled prompt, are both
  ignored. ^t-inference-login-scoping
- **Contract** (scripted auth flows, `logout`): `logout` deletes the stored
  credential and returns `{}`, leaving an ambient env credential intact (the
  provider stays configured via the env var). ^t-inference-logout
- **Seam** (real pi-ai `openai-completions` over local HTTP, real socket):
  driving a `respond` through the stock provider against a local SSE server
  crosses the whole gateway↔pi-ai path for real — the resolved credential
  reaches the provider as the bearer token (and never the wire), the context
  maps into the provider request, real pi-ai stream events reduce to the exact
  `respondEvent` shapes and the real terminal becomes the result; a real
  `cancel` tears down the in-flight HTTP read → code 4 with the partial; and the
  explicit retry bound reaches the SDK's retry loop (an initial attempt plus the
  bounded retries, then `response_failed`). ^t-inference-real-pi-ai
