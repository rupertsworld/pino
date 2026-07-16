*Where Pino keeps things on disk: the state directory, and how running
processes advertise themselves so clients can find them.*

# Storage

Authoritative for the state directory layout, the run directory, and
descriptor files. The wire spoken over a discovered endpoint is owned by
[[transport.md]].

## State directory

`PINO_STATE_DIR` is the root of all persistent and runtime state. Default:
`~/.pino`.

```text
$PINO_STATE_DIR/
  run/           # run directory: ephemeral, per-process (see below)
  gateway/       # durable gateway state (owned by [[gateway.md]])
```

The layout composes two axes: **lifecycle at the top** (`run/` is ephemeral
and sweepable; everything beside it is durable), **ownership within** (a
component's things live under its name; a singleton's run-directory entries
may sit flat). Durable state and sweepable state never share a directory —
that separation is what makes stale-cleanup in `run/` safe to do
aggressively.

## Run directory

`$PINO_STATE_DIR/run/` holds *ephemeral facts about currently-running
processes* — descriptor files and, by convention, their sockets. Nothing in
it is meaningful after its process dies; anything stale is trash to be swept.

```text
run/
  gateway.json                                  # singleton descriptor
  gateway.sock
  runners/
    01980b3f-8d2e-7c4a-9a71-52e30f8c25d1.json   # one per live runner,
    01980b3f-8d2e-7c4a-9a71-52e30f8c25d1.sock   # filename = instance id
```

Naming convention: a singleton component (one per machine, e.g. the gateway)
lives flat as `<component>.json`; a multi-instance component lives in a
`<component-plural>/` folder where each descriptor's filename is the
instance id. Identity lives entirely in these well-defined names — clients
look descriptors up by exact name (a runner's instance id is its session id,
so "the runner for session X" is `runners/<X>.json`), or list a folder to
enumerate live instances. Instance ids are opaque strings at this layer.

## Descriptor files

A serving process writes its descriptor on startup and removes it (and its
socket) on clean shutdown. One writer per descriptor: only the owning
process ever writes it — this keeps creation atomic and cleanup a plain
unlink, with no shared files to lock or repair. ^storage-descriptor-writer

```json
{
  "transport": "unix",
  "path": "/home/rupert/.pino/run/gateway.sock",
  "pid": 40112,
  "startedAt": "2026-07-15T18:22:07Z"
}
```

- `transport` — endpoint type. `"unix"` is the only v0 type; others (named
  pipes, tcp) are future additive types. Clients MUST dial whatever the
  descriptor says rather than assuming a transport, so new types arrive
  without breaking old clients. ^storage-dial-descriptor
- `path` — the endpoint to dial. Binding: sockets sit beside their
  descriptors by convention, but the descriptor's `path` is the only
  authority — a component may place its socket elsewhere (e.g. when a long
  state-dir path would exceed the Unix socket path limit).
- `pid` — the owning process. A descriptor whose pid is not alive is
  *stale*: any process may delete it and its socket. This makes the run
  directory self-healing after crashes.
- `startedAt` — ISO 8601 start time, informational.
