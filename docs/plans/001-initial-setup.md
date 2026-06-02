# Pino initial setup

## Overview

Pino is a minimal, fast, extensible agent harness based on Pi. It starts from Pi because Pi already provides a strong coding-agent runtime, TUI, model support, and extension architecture, but Pino is more opinionated about the out-of-box harness: Telegram should work as a first-class control channel, sandboxing should be available by default, and the architecture should leave room for background-agent orchestration, cron-style automation, and file/folder watchers.

Pino is not intended to become a broad personal-assistant gateway like OpenClaw, nor a heavy self-improving agent platform like Hermes. The goal is a lean agent-as-computer harness: small core, composable plugins, explicit process control, and enough batteries included that it can run useful remote agent sessions without a pile of manual setup.

This first setup is deliberately narrow: package Pino as a distributable `pino` CLI that wraps `pi-coding-agent`, launches the existing rich interface, and preloads Telegram so the active agent can be reached remotely. We use Pi’s coding-agent UI and extension system now to get running quickly, while keeping the path open to replace or adapt pieces later.

## Behavior

### Install and launch

A user can install Pino as a CLI package:

```bash
npm install -g <pino-package>
```

Then run it from any project directory:

```bash
cd /path/to/project
pino
```

Running `pino` starts the Pi coding-agent interactive interface in that directory. The user gets the rich terminal coding-agent experience — chat history, editor, streaming responses, tool output, model/session controls — but launched through Pino’s CLI and defaults rather than by running `pi` directly.

### Telegram setup inside Pino

Pino preloads the Telegram extension. After `pino` starts, Telegram commands are available inside the interactive editor.

The first-time setup flow is run from the active Pino session:

```text
/telegram-setup
```

The extension prompts for the bot token, validates it with Telegram, saves its configuration, starts polling, and asks the user to send `/start` to the bot to pair their Telegram account.

On later runs, the user can reconnect the current Pino session to the configured bot with:

```text
/telegram-connect
```

The Telegram bridge is session-local: only the connected Pino session receives Telegram messages, and only one session should own the bot at a time. For this prototype, Pino does not add a separate host-level setup command such as `pino telegram setup`; that can be added later if we want Telegram setup to feel more like a Pino CLI feature.

### Pino package namespace

Pino uses its own home directory instead of the user’s normal Pi directory. On startup, Pino ensures the Pino settings file exists and seeds it with the blessed package list:

```json
{
  "packages": ["npm:@llblab/pi-telegram@0.15.0"]
}
```

Pino then starts the Pi coding-agent runtime with `~/.pino` as its `agentDir` and sets `PI_CODING_AGENT_DIR` to the same path before extensions load. Packages, extension config, sessions, Telegram runtime files, global instructions, and global skills should therefore live under Pino’s namespace rather than the normal `~/.pi` or `~/.agents` namespaces. The intended storage layout is specified in `docs/storage.md`.
