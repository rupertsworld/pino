# Prior conventions (pino v0.1)

Reference digest of the conventions from pino v0.1 — the prototype that
wrapped `@earendil-works/pi-coding-agent`. The v2 rearchitecture deleted that
code from this branch; the full v0.1 spec and source remain on `main`
(`docs/spec.md`) and in git history. The `feat/acp-socket` branch additionally
exposed a live session over a Unix socket via ACP (~1k lines, tested) and is
kept as reference material.

These are records of what v0.1 did, not decisions for v2. Carry, adapt, or
drop each one explicitly as v2's spec settles.

## Identity

- npm package `pino-agent`, CLI binary `pino`, versions 0.1.x published.
- Framing: "Pino is an agent kernel" — small runtime, state layout, resource
  policy, lifecycle; capabilities live outside the kernel
  (see `docs/principles.md`, which v2 keeps).

## State directory

- `PINO_STATE_DIR`, default `~/.pino`, holds all persistent state:

  ```text
  settings.json      # Pino/Pi settings, including bundled extension packages
  auth.json          # model/provider auth managed by Pi
  models.json        # optional custom model definitions
  sessions/          # conversation sessions
  npm/               # npm-backed Pi package store
  git/               # git-backed Pi package store
  SYSTEM.md          # user-owned base system prompt
  AGENTS.md          # user-owned global context/instructions
  skills/            # user-owned global skills
  extensions/        # user-owned drop-in extensions (late v0.1, uncommitted)
  ```

- Passed to Pi as the coding-agent `agentDir` via
  `PI_CODING_AGENT_DIR=$PINO_STATE_DIR`.
- Isolation rule: Pino loads resources only from its state directory — no
  implicit inheritance from `~/.pi/`, `~/.agents/`, `./.pi/`, or `./AGENTS.md`.
  A Pino installation and a normal Pi installation never share resources.
- First run scaffolds missing files from the shipped `default-state/` without
  overwriting existing user files.
- One global resource namespace; project-level resources were out of scope.

## Workspace

- `PINO_WORKSPACE`, default: current directory — where tools act. Explicitly
  distinct from the state directory.
- Sessions stored under `$PINO_STATE_DIR/sessions/`, keyed by workspace path;
  launching `pino` continued the workspace's most recent session.

## Settings and prompts

- `settings.json` shape:

  ```json
  {
    "systemPrompt": "SYSTEM.md",
    "timeZone": "America/Los_Angeles",
    "contextFiles": ["AGENTS.md"]
  }
  ```

- Relative resource paths resolve against the settings file that declared
  them; `~` expands; absolute paths used as-is.
- `SYSTEM.md` is the user-owned base system prompt. Missing file → warn and
  use an empty base prompt, never invent one.
- `SYSTEM.md` supported variable interpolation — `{{STATE_DIR}}`,
  `{{WORKSPACE_DIR}}`, `{{DATE}}`, `{{TIME}}`, `{{TZ}}` — re-rendered before
  each turn (no restart needed for time/timezone changes). Unknown variables
  were errors.
- `contextFiles` passed to Pi as context files, not appended to the system
  prompt — keeps them reported as loaded and included across compactions.
  Missing context files warn and skip.

## CLI

- Surface was deliberately tiny: `pino` (launch interactive Pi TUI in the
  workspace), `--help`, `--version`.

## Bundled extensions

- First-class integrations shipped as ordinary Pi packages seeded into
  `settings.json` — never vendored source.
- v0.1 bundled Telegram: token setup and pairing from inside the session;
  session-local (one session owns the bot; only the connected session
  receives messages).

## Development practice

- TypeScript run directly with Node's type stripping (`node src/cli.ts`) —
  no build step in development; `tsc` only for publishing.
- Tests via `node --test`.
- Spec-driven: the spec is the contract; code follows it.
