*How Pino components talk to each other over a connection: the low-level
rules every wire shares, regardless of which components are speaking.*

# Transport

Authoritative for the wire between components. How endpoints are discovered
and dialed is owned by [[storage.md]]; the meaning of messages (methods,
fields) is owned by each wire's schema spec.

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
  `result` or `error` — matched by that id.
- A **notification** carries no `id` and is never replied to, not even with
  an error (per the JSON-RPC spec). If the sender would care about the
  outcome, the method should be a request.
- JSON-RPC's batch form (an array of messages) is excluded — the framing
  rule of one object per line already forbids it; multiple messages are
  multiple lines.

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
  version. The server accepts by echoing the version, or refuses with an
  error naming the versions it supports; the dialer may retry with one of
  those. Exact-match negotiation: a server may support several versions, but
  a connection speaks exactly one — no ranges, no capability matrices.
- Until `initialize` resolves, nothing else is allowed on the connection:
  other requests are answered with an error, notifications are ignored.
  "Connected but not negotiated" stays a state with no behavior.
- `clientInfo`/`serverInfo` (`name`, `version`) is identification for logs
  and debugging only — no behavior may key off it. Behavior keys off schema
  version alone; the moment identity matters, interchangeable
  implementations stop being interchangeable. (Field names as in MCP.)

## Errors

Errors are JSON-RPC error objects — `{"code": <integer>, "message": "...",
"data": ...}` — following the JSON-RPC 2.0 spec's own rule: codes in the
reserved range (-32768 to -32000) belong to the protocol (parse error
-32700, method not found -32601, invalid params -32602, the server-defined
band -32000 to -32099 for transport-level conditions such as "not
initialized"). Application errors are defined by each schema spec, with
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
