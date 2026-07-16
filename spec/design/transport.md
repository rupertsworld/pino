*How Pino components talk to each other over a connection: the low-level
rules every wire shares, regardless of which components are speaking.*

# Transport

Authoritative for the wire between components. How endpoints are discovered
and dialed is owned by [[storage.md]]; the meaning of messages (methods,
fields) is owned by each wire's schema spec. Realized by the shared
`transport` package ([[implementation/index.md]]).

## Framing

A *message* is one JSON object, sent as one line of UTF-8 text terminated by
`\n` — the JSON Lines (NDJSON) convention, the same framing MCP's stdio
transport, ACP, and mpv's JSON IPC use.

- One JSON object per line. Never an array, never multiple objects on a
  line.
- A message contains no literal newline. JSON string escaping already
  guarantees this (`\n` inside a value is two characters), so the delimiter
  can never appear inside valid message bytes.
- A reader buffers bytes, splits on `\n`, and parses each line as JSON.
- A reader enforces a maximum message size, closing the connection when a
  line exceeds it — unbounded line-buffering is an out-of-memory hazard,
  since a peer can send bytes with no delimiter. v0 components cap at
  16 MiB (large enough for base64 image content; the number is otherwise
  arbitrary).

Rationale: a socket is a byte stream with no message boundaries; reads may
slice messages anywhere, so the bytes must mark where a message ends. A
newline delimiter costs one byte, makes boundary detection a line-split in
any language, and keeps the wire speakable by hand (`socat` sends a message
on enter) — unlike length-prefixed framing (a header format to parse, byte
counts a human can't type) or bare concatenated JSON (needs a streaming
parser, desynchronizes on a corrupt byte).

## Envelope

Every message is a [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
message. Three kinds, distinguished by the presence of `id`:

```
{"jsonrpc":"2.0","id":7,"method":"prompt","params":{...}}      request
{"jsonrpc":"2.0","id":7,"result":{...}}                        response
{"jsonrpc":"2.0","id":7,"error":{"code":1,"message":"..."}}    response (error)
{"jsonrpc":"2.0","method":"delta","params":{...}}              notification
```

- A **request** carries an `id` and is owed exactly one **response** —
  `result` or `error` — matched by that id. An `id` is a **string or a finite
  number**; a message whose `id` is present but of any other type (boolean,
  object, array, `null`, non-finite number) is not a correlatable request and
  is rejected `-32600`.
- An `id`, once used on a connection, is **spent for the connection's
  lifetime**: a later request naming it is rejected `-32600` regardless of
  which method names it and regardless of how the first request was answered
  (a `result`, a `method not found`, a `not initialized` — all spend the id).
  Reusing an id would make response and cancellation correlation ambiguous; a
  late `cancel` for a completed request must never reach a new one. A retry
  therefore uses a fresh id — including an `initialize` retried after a
  rejection.
- A **notification** carries no `id` and is never replied to, not even with
  an error (per the JSON-RPC spec). If the sender would care about the
  outcome, the method should be a request.
- A **response** carries exactly one of `result` or `error`; one carrying
  both, or naming an id the receiver never sent, is dropped.
- JSON-RPC's batch form (an array of messages) is excluded — the framing
  rule of one object per line already forbids it; multiple messages are
  multiple lines.
- Senders always include the `"jsonrpc":"2.0"` tag; receivers tolerate its
  absence (the same lenient posture as the unknown-field rule — strictness
  here would catch nothing real), but a `jsonrpc` member that is *present*
  with any value other than `"2.0"` is invalid — leniency is for omission,
  not for a wrong version.

Which methods are requests and which are notifications is a per-method
choice owned by each schema spec: commands whose outcome matters are
requests; high-rate or fire-and-forget traffic (streamed deltas, event
feeds) is notifications.

## Direction

The wire is direction-blind: on an open connection, either peer may send
requests and notifications. There is no fixed asker/answerer split — a
listening component may put a request to the peer that dialed it, and every
conforming peer must tolerate incoming requests (answering `method not
found` is a conforming response).

Because both sides mint request ids independently, ids are scoped **per
direction**: each side matches responses against its own outbound ids only;
the two sides' id spaces never interact. (Standard bidirectional JSON-RPC,
as in LSP and MCP.)

Rationale: the session wire is expected to carry questions from a runner to
an attached surface — approvals, choices — which are requests flowing
listener→dialer and needing answers. A one-directional rule would make that
a breaking change later; direction-blindness makes it new methods.

## Handshake

`initialize` is the first request on every connection, sent by the dialer.
It is defined once here and used by every wire; schema names and version
numbers are declared by each schema spec, not this document.

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":
     {"schema":"<schema-name>","version":1,
      "clientInfo":{"name":"<impl-name>","version":"<impl-version>"}}}
← {"jsonrpc":"2.0","id":1,"result":
     {"version":1,"serverInfo":{"name":"<impl-name>","version":"<impl-version>"}}}
```

- The dialer states which schema it intends to speak and at what integer
  version. The listener accepts by echoing the version, or refuses with
  `invalid params` (-32602) carrying `data: {supported: [...]}`; the dialer
  may retry with one of those. Exact-match negotiation: a listener may
  support several versions, but a connection speaks exactly one — no
  ranges, no capability matrices.
- A connection moves through three states: `uninitialized` →
  `initializing` → `initialized`. Dispatching `initialize` enters
  `initializing` synchronously; the connection commits to `initialized`
  **only after the handler resolves successfully**, and a rejected
  `initialize` returns it to `uninitialized` so the dialer may retry (with a
  fresh id). Until it is `initialized` — while `uninitialized` *and* while
  `initializing` — nothing else is allowed: other requests are answered with
  `-32002` not initialized, notifications are ignored. This closes the
  pipelining gap: an ordinary request arriving in the same chunk as a slow
  `initialize` cannot run before negotiation succeeds, and cannot run at all
  if it fails. "Connected but not negotiated" stays a state with no behavior.
- `initialize` happens exactly once per connection; a repeat is rejected
  with `-32003` already initialized — including a second `initialize`
  pipelined into the same chunk, which finds the connection already
  `initializing`.
- `clientInfo`/`serverInfo` (`name`, `version`) is identification for logs
  and debugging only — no behavior may key off it, so `clientInfo` is
  **optional** and is neither required nor validated (the shape above shows
  it for illustration). Behavior keys off schema version alone; the moment
  identity matters, interchangeable implementations stop being
  interchangeable. (Field names as in MCP.)

## Errors

Errors are JSON-RPC error objects — `{"code": <integer>, "message": "...",
"data": ...}` — following the JSON-RPC 2.0 spec's own rule: codes in the
reserved range (-32768 to -32000) belong to the protocol (parse error
-32700, method not found -32601, invalid params -32602). The server-defined
band (-32000 to -32099) holds transport-level conditions: `-32002` not
initialized, `-32003` already initialized. Application errors are defined by each schema spec, with
codes outside the reserved range. `message` is human-readable and
non-contractual; `data` carries structured detail as defined by the owning
schema.

## Streaming

This spec defines no streaming convention. Streamed and partial results are
plain notifications; how they correlate to a request, a session, or any
other domain object is a params field owned and defined by each schema spec
(as in ACP, where updates carry the session id in params). The envelope
never grows correlation members.

## Compatibility

What a peer does with what it doesn't recognize:

- **Unknown fields are ignored** — never an error. This lets a schema add
  optional params and result fields without a version bump; old peers just
  don't see them.
- **Unknown methods** get `method not found` when they are requests, and are
  silently dropped when they are notifications (which cannot be replied to).
  The sender learns the capability is absent and degrades.

Together with the handshake this is the growth policy: *additive* change —
new methods, new optional fields — happens freely within a schema version;
*shape* change — renaming a field, changing a type, making optional required
— requires a version bump. Version bumps are rare and deliberate.

Trade accepted knowingly: ignoring unknown fields means a typo in an
optional field name fails silently. Strict validation would catch it, but
would make every addition a breaking change across independently-shipped
components — the wrong trade. Typos are caught by tests and schema
conformance checks, not by the wire.

## Test assertions

Shapes per [[spec-policy.md#^test-shapes]]. Framing is proven in isolation on
the line splitter. Every other assertion is a **Seam** over a **real Unix
socket**: the real transport server and client, speaking a neutral test schema
(proving the wire is not inference-specific), with method handlers as test
fixtures — the transport itself is never mocked.

- **Contract** (line splitter, no socket): a reader splits NDJSON on `\n` and
  reassembles a message sliced across arbitrary chunk boundaries — a multi-byte
  UTF-8 character cut mid-character, and a >1 MiB body arriving in many small
  chunks — emitting each message exactly once; a line exceeding the 16 MiB cap
  with no delimiter throws before buffering unbounded, while a line exactly at
  the cap is accepted. ^t-transport-framing
- **Seam** (framing over the socket): messages dribbled across arbitrary write
  boundaries frame correctly; a line exceeding 16 MiB closes the connection.
  ^t-transport-overflow
- **Seam** (envelope parsing): malformed JSON is answered `-32700` with
  `id: null`; a batch array and any non-object message are `-32600`; a request
  whose `id` is present but not a string or finite number is `-32600` with
  `id: null`; a present `jsonrpc` tag that is not `"2.0"` is `-32600`; a
  response carrying both `result` and `error` is dropped without crashing the
  connection. ^t-transport-envelope
- **Seam** (handshake negotiation): the happy path echoes the version and
  `serverInfo`; an unsupported version or an unspoken schema is refused with
  `-32602` carrying `data.supported`, leaving the connection un-negotiated so a
  retry with a supported version succeeds; unknown params fields are ignored;
  `initialize` with no `clientInfo` succeeds (it is optional). ^t-transport-handshake
- **Seam** (handshake once-only): before `initialize` resolves, a request gets
  `-32002` and a notification is ignored; a repeat `initialize` — including one
  pipelined into the same chunk — is rejected `-32003`, and the connection
  stays initialized. ^t-transport-handshake-once
- **Seam** (initializing state): a deferred `initialize` that ultimately
  *rejects*, pipelined with an ordinary state-changing request in the same
  chunk, holds the connection `initializing` — the ordinary request is answered
  `-32002` and its handler does not run before `initialize` resolves; on
  rejection the connection returns to `uninitialized` and a fresh-id
  `initialize` succeeds. ^t-transport-initializing
- **Seam** (connection-lifetime id no-reuse): an `id` already in flight is
  rejected `-32600` whatever method names it, and stays spent for the whole
  connection lifetime — reused after the first request completes it is rejected
  again and re-invokes no handler — while a fresh id works; the id is spent
  regardless of how the first request was answered, so an id previously answered
  `-32002` or `-32601` is likewise rejected `-32600` on reuse. ^t-transport-id-reuse
- **Seam** (unknown methods): an unknown request method gets `-32601`; an
  unknown notification is never answered; unknown fields on an ordinary method
  are ignored. ^t-transport-unknown
- **Seam** (bidirectional lifecycle): a listener can put a request to the
  dialer and match its response; the two directions' id spaces never collide;
  concurrent requests complete out of order, each answered exactly once; a stray
  response to an unsent id is dropped; every server-originated response, request,
  and notification carries the `jsonrpc:"2.0"` tag. ^t-transport-bidirectional
- **Seam** (notification finality): a known notification handler runs exactly
  once and is never answered, even when it throws. ^t-transport-notification
- **Seam** (disconnect): a server→client request still pending when the dialer
  disconnects rejects rather than leaking a forever-pending promise; a
  server→client request *made after* the connection has closed rejects
  immediately rather than hanging. ^t-transport-disconnect
- **Seam** (close-listener resilience): a close listener that throws is caught
  and logged, and teardown continues to run the remaining listeners.
  ^t-transport-close-listeners
- **Seam** (tag leniency): a request omitting the `jsonrpc` tag still succeeds,
  on `initialize` and on an ordinary method. ^t-transport-tag-leniency
- **Seam** (handler errors): a handler throwing a plain error is answered
  `-32603` and logged to stderr with a stack; an `RpcError` surfaces its code,
  message, and data; an `RpcError` whose `data` cannot be serialized still
  answers the request with a guaranteed-serializable `-32603` rather than
  dropping the response. ^t-transport-handler-errors
