*Where Pino keeps things on disk: the state directory, and how running
processes advertise themselves so clients can find them.*

# Storage

Authoritative for the state directory layout, the run directory, and
descriptor files. The wire spoken over a discovered endpoint is owned by
[[design/transport.md]]. Realized by the shared `storage` package
([[implementation/index.md]]).

## State directory

`PINO_STATE_DIR` is the root of all persistent and runtime state. Default:
`~/.pino`.

```text
$PINO_STATE_DIR/
  run/           # run directory: ephemeral, per-process (see below)
  gateway/       # durable gateway state (owned by [[implementation/gateway.md]])
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

`run/` is created with mode `0700`. This is the wire's entire access-control
story: sockets inside an untraversable directory are reachable only by the
owning user, which is what makes the same-user trust model true rather than
assumed.

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
- `path` — the endpoint to dial. For v0 a component's socket MUST live in
  `run/` beside its descriptor, at the conventional path (`gateway.sock`
  beside `gateway.json`); `path` tells a client where to dial but always
  resolves within `run/`. The escape hatch — placing a socket elsewhere when
  a long state-dir path would exceed the Unix socket path limit — is deferred
  until runners need it, and will be designed sweep-safe then. Because the
  sweep constructs the conventional socket path itself and never reads a
  descriptor-supplied `path` to decide what to delete, it can only ever delete
  within `run/`: a stale or hand-corrupted descriptor has no `path` for the
  sweep to follow, so it cannot become an arbitrary-file delete. The run
  directory is the sweep's blast radius, by construction. ^storage-sweep-scope
- `pid` — the owning process, *informational* (discovery/debugging). It is no
  longer the singleton's liveness mechanism — the lock is ([[#^storage-singleton]]).
  For discovery, a failure to dial a descriptor's `path` is the staleness
  signal: a client that cannot reach the endpoint treats the descriptor as
  stale and may sweep and re-resolve. A descriptor that cannot be parsed is
  stale (a live single-writer could not have produced it), as is a socket file
  with no descriptor beside it — crash leavings, swept the same way. This keeps
  the run directory self-healing after crashes.
- `startedAt` — ISO 8601 start time, informational.

A singleton component claims its name with a **proper advisory lock**
(`proper-lockfile`), acquired before any socket bind and held for the process
lifetime. The lock is the sole mutual-exclusion mechanism: a live holder
refreshes the lockfile mtime, so any second start is refused; a crashed holder
stops refreshing, its lock goes stale by mtime, and the library reclaims it
automatically for the next claimer. There is no pid-based stale-descriptor
reclaim, so the multi-starter race the old hand-rolled claim could not close
(a claimer vacating a live descriptor in a window while a third wins) does not
exist: for any number of simultaneous starts, exactly one acquires the lock and
the rest refuse. On acquiring the lock the claimant overwrites `gateway.json`
and removes any leftover `gateway.sock` — the lock guarantees no live
predecessor, so both are crash leavings — then binds. On clean shutdown it
removes the descriptor and socket and releases the lock. The one behavioral
tradeoff: crash recovery is not instant but bounded by the stale window (a few
seconds; the implementation uses 5s). Rationale: single-instance claims
elsewhere (e.g. the gateway's single-writer credential file) are licensed by
this rule; without it, "singleton" would be an assertion, not a property.
^storage-singleton

## Test assertions

Shapes per [[spec-policy.md#^test-shapes]]. The claim and socket sweep run
against the **real filesystem**. Mutual exclusion is proven with real held
locks — an in-process claim for the single-claimer cases, and N spawned
processes for the race. The descriptor lifecycle and cross-process refusal are
proven for real by spawning gateway processes.

- **Contract** (claim over the real fs): `PINO_STATE_DIR` resolves — honoring
  the env var, defaulting to `~/.pino` — and `run/` is created `0700`
  (idempotently, restoring the mode). On acquiring the lock the claim records
  `{transport, path: socket, pid, startedAt}` and returns a `release`; a clean
  release lets a subsequent claim succeed. ^t-storage-claim
- **Contract** (lock is the mutual exclusion): while a claim holds the lock a
  second claim refuses with `SingletonError`, throwing before it writes
  anything, so it leaves the holder's descriptor and socket untouched; a stale
  (old-mtime) lock is reclaimed, and on reclaim the crashed predecessor's
  descriptor is overwritten and its socket swept. ^t-storage-sweep
- **Contract** (socket sweep targets the conventional socket): the socket the
  claim sweeps is the conventional one it constructs beside the descriptor
  (`gateway.sock`); a socket the descriptor merely names via `path` is not
  followed for deletion, and an orphan socket with no descriptor beside it is
  removed ([[#^storage-sweep-scope]]). ^t-storage-sweep-named
- **Contract** (sweep bounded to `run/` by construction): the claim never
  consults `path` for deletion, so a descriptor naming a file **outside** `run/`
  never turns the sweep into an arbitrary-file delete — the descriptor is
  overwritten but the named file is untouched ([[#^storage-sweep-scope]]).
  ^t-storage-sweep-bounded
- **Seam** (real spawned gateway): a started gateway writes its descriptor and
  binds its socket under `run/` (`0700`), serves `initialize` on the endpoint
  the descriptor names, and removes both (releasing the lock) on clean shutdown
  — under SIGTERM and SIGINT, exit 0. ^t-storage-lifecycle
- **Seam** (real gateways race): with a real gateway already holding the lock a
  second start refuses with a nonzero exit and touches neither the holder's
  descriptor nor its socket; of two near-simultaneous starts exactly one wins
  the lock and serves; and N (≥3) processes claiming one run dir simultaneously
  resolve to exactly one owner with the rest refusing — deterministically, the
  property the old hand-rolled claim could not guarantee
  ([[#^storage-singleton]]). ^t-storage-race
