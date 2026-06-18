# Pino

Minimal Pi-based agent harness with Pino-owned state, prompt/context files, skills, sessions, and bundled defaults.

## Install

```sh
npm install -g pino-agent
```

Then run:

```sh
pino
```

## CLI

```sh
pino
pino --help
pino --version
```

## State

Pino uses its own state namespace:

- `PINO_STATE_DIR` — defaults to `~/.pino`
- `PINO_WORKSPACE` — defaults to the current directory

On first run, Pino scaffolds missing files from `default-state/` into `PINO_STATE_DIR` without overwriting existing files.

## Notes

Pino is an early prototype wrapper around `@earendil-works/pi-coding-agent`.
