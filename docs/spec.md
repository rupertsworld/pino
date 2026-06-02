# Pino spec

Pino is a minimal, fast, extensible agent harness based on Pi. It uses Pi's coding-agent runtime, TUI, model support, package system, and extension architecture, but gives them a Pino-controlled state directory, workspace, resource policy, and bundled extension set.

Pino is an agent kernel: a small runtime that starts a Pi-based agent, keeps its state separate from a normal Pi installation, and points it at a workspace where it can act. The first prototype focuses on a rich local coding-agent interface plus first-class Telegram access; future kernel capabilities include sandboxing, background-agent orchestration, cron-style automation, and file/folder watchers.

## State directory and resources

`PINO_STATE_DIR` is where Pino stores persistent kernel state, configuration, user-owned resources, and package installs.

Default:

```text
~/.pino
```

Example:

```bash
PINO_STATE_DIR=/srv/pino/state pino
```

Expected Pino-owned layout:

```text
$PINO_STATE_DIR/
  settings.json      # Pino/Pi settings, including bundled extension packages
  auth.json          # model/provider auth managed by Pi
  models.json        # optional custom model definitions
  sessions/          # conversation sessions
  npm/               # npm-backed Pi package store
  git/               # git-backed Pi package store
  SYSTEM.md          # user-owned base system prompt
  AGENTS.md          # user-owned global Pino context/instructions
  skills/            # user-owned global Pino skills
```

Pino passes this directory to Pi as the coding-agent `agentDir` and sets:

```bash
PI_CODING_AGENT_DIR=$PINO_STATE_DIR
```

Pino starts isolated. By default it loads resources only from this state directory, as declared in `$PINO_STATE_DIR/settings.json`:

```json
{
  "systemPrompt": "SYSTEM.md",
  "timeZone": "Australia/Sydney",
  "contextFiles": ["AGENTS.md"]
}
```

Relative resource paths in settings resolve relative to the settings file that declared them. For v0, that means relative to `$PINO_STATE_DIR/settings.json`. Absolute paths are used as-is, and `~` expands to the user's home directory.

The default scaffold includes:

```text
$PINO_STATE_DIR/SYSTEM.md
$PINO_STATE_DIR/AGENTS.md
$PINO_STATE_DIR/skills/
```

It should not implicitly inherit resources from:

```text
~/.pi/
~/.agents/
./.pi/
./AGENTS.md
```

This keeps Pino separate from a normal Pi installation. Project-level Pino resources can be added later, but the first prototype keeps one predictable global resource namespace.

Extensions may create additional files under `PINO_STATE_DIR` according to their own conventions. Pino does not standardize extension runtime state in v0.

## Workspace

`PINO_WORKSPACE` is where the agent works: the filesystem/project directory that tools operate in by default.

Default:

```text
current directory
```

Example:

```bash
PINO_WORKSPACE=/srv/pino/workspace pino
```

The workspace is not the same as the state directory. A common launch might be:

```bash
PINO_STATE_DIR=~/.pino \
PINO_WORKSPACE=~/dev/my-project \
pino
```

In that case:

```text
state/config/resources: ~/.pino
agent workspace:         ~/dev/my-project
```

## System prompt and context

Pino uses the user-owned system prompt file declared by `systemPrompt` in settings:

```json
{
  "systemPrompt": "SYSTEM.md"
}
```

If present, Pino renders it and uses it as the base system prompt. If missing, Pino warns and uses an empty base system prompt. The default scaffold creates `SYSTEM.md` on first run, but Pino does not overwrite an existing user file.

`SYSTEM.md` supports simple variable interpolation:

```text
{{STATE_DIR}}
{{WORKSPACE_DIR}}
{{DATE}}
{{TIME}}
{{TZ}}
```

`DATE` renders as `YYYY-MM-DD`, `TIME` renders as `HH:mm:ss`, and `TZ` renders as the configured IANA timezone from `settings.timeZone`. If `timeZone` is absent, Pino falls back to the host timezone when available or a UTC offset fallback. Dynamic variables are rendered before each agent turn, so time and timezone setting changes do not require restarting Pino. Unknown variables are errors.

Pino also loads user-owned context files declared by `contextFiles` in settings:

```json
{
  "contextFiles": ["AGENTS.md"]
}
```

Context files remain separate from `SYSTEM.md`. Pino passes them to Pi as context files rather than appending them to the system prompt itself. This keeps the base system prompt and user guidance separate, lets Pi report context files as loaded, and ensures the files continue to be included across conversation compactions. Missing context files warn and are skipped.

## CLI behavior

The public CLI surface for v0 is intentionally small:

```bash
pino
pino --help
pino -h
pino --version
pino -v
```

Running `pino` starts the Pi coding-agent interactive interface in the workspace. The user gets the rich terminal coding-agent experience — chat history, editor, streaming responses, tool output, model/session controls — but launched through Pino’s CLI and defaults rather than by running `pi` directly.

## Bundled extensions

Pino bundles first-class integrations by seeding package entries into `$PINO_STATE_DIR/settings.json`. Bundled extensions are ordinary Pi packages, not vendored Pino source. The exact package names, versions, commands, and UI controls are implementation details owned by the bundled extension packages.

For v0, Pino bundles a Telegram integration. The expected behavior is:

- the user does not manually install a Telegram package before using Pino;
- Telegram setup and connection controls are available from inside the interactive Pino session;
- the user can configure a bot token and pair their Telegram account;
- the active Pino session can receive Telegram messages and reply through the bot;
- Telegram is session-local: only the connected Pino session receives messages, and only one session should own the bot at a time.
