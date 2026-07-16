*Pino runs AI agents as small persistent processes you can attach to and
detach from. This is the root spec: what Pino is, its principles, and its
parts.*

# Pino spec

Pino is an agent microkernel based on [Pi](https://github.com/badlogic/pi-mono).

Pino takes Pi apart and re-forms it as a small set of processes that message
each other: a tiny kernel — the agent loop, its session log, a socket — and
everything else attached as services. Each part can be upgraded, replaced, or
rewritten independently, because the contracts between parts are the stable
surface, not the code. Like Pi, Pino is minimal and extensible.

## What Pino is for

- **Agents as processes.** Each running agent is its own addressable process:
  start it, list it, message it, supervise it like any other service on the
  machine. Its lifetime is its own — it keeps working with nothing attached,
  survives disconnects, and one agent crashing cannot take down another.
  Addressable means anything can reach it: a CLI, a cron job, another agent.

- **Surfaces that attach.** Interfaces are clients of the agent, not its
  owner. Connect from a terminal, a GUI, Telegram, an editor — the same live
  agent, several surfaces at once or none at all. Closing a surface never
  ends the work; reattach and catch up.

- **Built for speed.** Parts are separate processes joined by stable
  contracts, so each can be upgraded alone: swap a TypeScript service for a
  compiled binary, replace a borrowed Pi component with a purpose-built one,
  adopt faster technology piece by piece — no big-bang rewrite, and no client
  notices.

## Principles

- **Contracts are message schemas.** Components share no domain code and
  import nothing of each other's logic; the only thing that crosses a
  component boundary is serialized messages. The authoritative definition of
  every boundary is a schema in `spec/`, owned by Pino — never a type in an
  implementation's source. A schema may be derived from an existing
  implementation's shapes, but Pino's document is the contract. (Sharing an
  *implementation of a cross-cutting spec* — the `transport` and `storage`
  packages — is not this coupling: the contract is still the spec, which a
  component in another language reimplements. See [[implementation/index.md]].)
- **Components are addressable processes.** Each component runs as its own
  process and listens on its own endpoint. Any component can be reimplemented
  in any language and interoperate, because conformance means speaking the
  schemas, not linking the code.

## Conventions

Method and message field names are camelCase — Pi's convention, shared by
MCP and LSP (`listModels`, `clientInfo`). Names borrowed from another
protocol or from Pi keep their original spelling, including literal values
(`"api_key"` in a credential is Pi's value, kept verbatim).

## Components

A **session** is the durable object: an identity plus its log. Sessions
outlive processes. User-facing surfaces speak in sessions; the architecture
names the mechanism that runs them.

- **gateway** — the inference provider gateway. Fronts model providers:
  model catalogs, credentials, request streaming. Serves the inference
  schema. Credentials never leave it. v0 wraps `pi-ai`.
- **runner** — one process running one live session: the loop, its queues,
  its log. Serves the session schema to clients; consumes the gateway. While
  a runner lives, memory is the truth and the log is the record; after a
  crash or restart, a new runner picks the session up from its log. v0 wraps
  `pi-agent-core`'s `AgentHarness`.
- **cli** — a minimal client: plain stdin/stdout, talks to one runner. The
  reference surface, and the proof the session schema is speakable with
  regular io. Consumes only; listens on nothing.
