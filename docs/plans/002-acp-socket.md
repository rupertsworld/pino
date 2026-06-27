# Pino ACP socket

## Problem / goal

We want to reach a running Pino session from [Television](https://github.com/telepath-computer/television) (a virtual display for agents) over ACP (Agent Client Protocol), so the Television chat UI drives **the exact same live session** the user is working in at the terminal — not a separate spawned agent.

Pi's `AgentSession` lives in-process, one per process; pi has no daemon, socket, or multi-client attach. So a Television-spawned `pino` subprocess would be a *different* conversation. To share the live session, Pino itself must host it and expose a listener that other clients attach to. This plan covers the Pino side. The Television side (a generic `TELEVISION_ACP_COMMAND`) is tracked in the Television repo branch `feat/generic-acp-command`.

## Current behavior / context

`pino` (see `src/cli.ts`, `createPinoRuntime`) builds a pi `AgentSession` runtime and runs the interactive TUI (`mode.run()`). The session is owned in-process by the TUI; nothing else can observe or drive it.

## Expected behavior

- On every `pino` run, Pino opens a unix socket at `$PINO_STATE_DIR/acp.sock` by default, exposing the **same in-process `AgentSession`** over ACP. No subcommand or flag is required to enable it.
- An external ACP host (Television) connects through a thin relay (`pino acp-attach`, a stdio↔socket bridge), attaches to the live session, and can send prompts and receive streamed assistant text and basic tool-call updates. Messages typed in the terminal TUI and in the attached client land in the one shared session.
- The socket is invisible when unused and never destabilises the TUI:
  - On startup, if the socket path exists but nothing is listening (stale from a crash), unlink and rebind.
  - If something *is* already listening (a second concurrent `pino`), do not crash — log and run without the listener. Single-pino is the supported case for now.
  - Clean up the socket on exit.

## Acceptance criteria

- [ ] Running `pino` creates a listening socket at `$PINO_STATE_DIR/acp.sock`; removing/relaunching cleans up a stale socket and rebinds.
- [ ] A second concurrent `pino` starts normally (TUI works) and logs that the ACP listener was skipped; it does not throw.
- [ ] On exit, the socket file is removed.
- [ ] An ACP `initialize` + `session/new` (or `session/load`) handshake over the socket succeeds and binds to the running session.
- [ ] A prompt sent over ACP runs in the shared session; assistant text streams back as ACP `session/update` `agent_message_chunk`s; the same exchange is visible in the terminal TUI.
- [ ] Tool calls surface as ACP `tool_call` / `tool_call_update` updates (basic text-level: id, title, kind, status, aggregated output). Rich diff/terminal payloads are out of scope (M1).
- [ ] `pino acp-attach` relays a stdio ACP stream to/from the socket so Television can spawn it as `TELEVISION_ACP_COMMAND="pino acp-attach"`.
- [ ] New unit tests cover socket lifecycle (create, stale-cleanup, second-instance skip, exit cleanup) and the ACP handshake/prompt round-trip against a fake/headless session.

## Non-goals / constraints

- No multi-session discovery/selection — single running `pino` only.
- No ACP `requestPermission` UX over the socket: permission prompts stay in the TUI (the host owns them); Television auto-cancels permission requests today, consistent with the existing Hermes path.
- No rich tool-call rendering (diffs, terminals, structured raw I/O) in M1.
- Remote transport (HTTP/WS, Tailscale) is out of scope here; the socket is local. The unix socket is a network endpoint shape, so remote is a later, additive step with no redesign.
- Do not fork or modify third-party pi; build only on its public `AgentSession`/SDK surface.

## Proposed approach

1. **Hold the session reference.** In `createPinoRuntime` (or the runtime factory callback), capture the live `AgentSession` and hand it to an ACP listener started alongside the TUI.
2. **ACP server over the socket.** Use the ACP TypeScript SDK (`@agentclientprotocol/sdk` / `agent-client-protocol`) to implement the agent side. For each socket connection, run an ACP agent connection whose `prompt`/`cancel` drive the shared `AgentSession` and whose handler forwards `AgentSession` events as ACP `session/update` notifications (assistant chunks + tool_call/tool_call_update). `session/new` and `session/load` both bind to the single live session (deterministic, no session-id bookkeeping).
3. **Socket lifecycle module.** Small, testable module: resolve path from `PINO_STATE_DIR`, stale detection (try-connect → unlink), bind, second-instance skip, cleanup on exit.
4. **`pino acp-attach` relay.** A `commander` subcommand that pipes its stdin/stdout to the socket as raw ACP frames (newline-delimited JSON). Trivial and dependency-light.

Exact pi `AgentSession` event/method shapes and the ACP SDK agent surface are being confirmed by research; this plan will be refined to match before coding.

## Test strategy

- **Unit (node:test, repo convention `node --test test/**/*.test.ts`), test-first:**
  - Socket lifecycle: create/stale-cleanup/second-instance-skip/exit-cleanup, using a temp `PINO_STATE_DIR`.
  - ACP round-trip: drive the ACP server with an in-memory/fake `AgentSession` (or a scripted stub) — assert initialize/new-session/prompt produce the expected `session/update` stream and that tool events map to `tool_call`/`tool_call_update`.
- **Manual e2e:** run `pino`, attach Television via `TELEVISION_ACP_COMMAND="pino acp-attach"`, confirm a shared-session exchange in both surfaces.

## Open questions / assumptions

- **Assumption:** a single `AgentSession` accepts a second subscriber/driver while the TUI is active; concurrent prompts are governed by pi's existing steering/follow-up queue modes. (Confirming in research; fallback is to serialise prompts at the listener.)
- **Assumption:** the ACP SDK agent side can run over an arbitrary `Readable`/`Writable` pair (the socket), not only `process.stdin`/`stdout`. (Confirming.)
- **Assumption:** Television's existing client tolerates a generic agent label without losing basic tool-call rendering (verified on the Television side).
