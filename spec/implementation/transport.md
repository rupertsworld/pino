*What the `transport` package provides — the reusable wire machinery every
Pino component links against. It realizes [[design/transport.md]], which
owns all wire behavior; this spec only names the pieces the module must
provide. The exported API is read from the code, not pinned here.*

# Transport package

`@pino-agent/transport` is mandated: every component speaks the wire through
it rather than re-rolling framing and JSON-RPC. This spec exists so a reader
knows what lives in the package without reading the source — not to duplicate
its signatures. [[design/transport.md]] wins on any behavioral question.

Provides:

- **Framing** — NDJSON line splitting with the size cap.
- **The JSON-RPC connection** — a server over a Unix socket carrying
  request / response / notification in both directions, and the
  inbound-request lifecycle it owns for every handler: a per-request abort
  signal, connection-lifetime id no-reuse, and cancel-by-id. Server→client
  requests support direction-blind flows.
- **The `initialize` handshake** — schema-agnostic; the caller supplies the
  schema name and versions it speaks.
- **Error types** — `RpcError` and the protocol error codes. No application
  codes: those belong to each schema and its component.
- **Test helpers** — a shared NDJSON test client (`.../transport/test-helpers`)
  so every component tests its wire against one client. A convenience for
  consumers' tests, not part of the contract.
