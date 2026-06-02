# Pino architecture options

This document compares two paths for building Pino: a fast, delegation-heavy coding agent with a rich terminal interface and compatibility with Pi's extension ecosystem.

The updated product constraint is important:

> Pino should have a full rich coding-agent interface. It does not need every Pi feature or slash command out of the box, but it should feel like a capable coding agent rather than a thin prompt runner.

That changes the trade-off. A raw `pi-agent-core` build remains attractive architecturally, but it means rebuilding a lot of interface and extension plumbing that Pi already has.

## Baseline: what Pi gives us

The relevant Pi layers are:

| Layer | Package | What it gives |
| --- | --- | --- |
| Model/provider layer | `@earendil-works/pi-ai` | model registry, provider adapters, streaming LLM events, message types, tool-call schemas |
| Agent runtime | `@earendil-works/pi-agent-core` | stateful agent loop, tools, parallel execution, events, steering/follow-up queues |
| Terminal UI toolkit | `@earendil-works/pi-tui` | component/rendering framework, editor, markdown, overlays, key handling |
| Full app layer | `@earendil-works/pi-coding-agent` | rich coding-agent interface, sessions, settings, auth/model registry, extensions, skills, commands, built-in tools, interactive/print/RPC modes |

There is also a supported rebranding hook in `pi-coding-agent`'s own development docs:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Changing `name`, `configDir`, and `bin` is explicitly described as the way to fork/rebrand the app. That matters for Option 1.

---

# Option 1: Adapt / fork `pi-coding-agent` into Pino

## Summary

Under this option, Pino becomes a real fork or adaptation of `pi-coding-agent`. We import or copy the coding-agent package structure, rename/rebrand it as Pino, keep the interactive UI and extension system, then remove or replace features we do not want.

This is the "Pino is its own Pi-derived agent app" approach.

## What we would reuse

From `pi-coding-agent`:

- interactive TUI application
- chat transcript renderer
- editor and autocomplete integration
- footer/status/header machinery
- session management
- settings management
- auth/model registry integration
- built-in tool definitions
- extension loader and runner
- extension UI protocol
- command system
- resource loading for extensions/skills/prompts/themes
- print and RPC modes if wanted
- HTML/session export machinery if wanted

From lower layers:

- `pi-ai`
- `pi-agent-core`
- `pi-tui`

## What we would change

Likely changes:

- package name and binary: `pino`
- config directory: probably `.pino` / `~/.pino/agent`
- default system prompt and identity
- default enabled tools
- startup resource discovery
- built-in slash command list
- default settings
- package/extension paths
- any references to Pi in banners/help text
- add Pino-specific delegation/background-agent features

The built-in Pi development docs explicitly support rebranding through `package.json` fields, but a full fork would still require auditing user-facing strings and behavior.

## Extension compatibility

This option gives the strongest extension compatibility.

Pi extensions are written against the `pi-coding-agent` extension API. That API expects concepts such as:

- `ExtensionRunner`
- extension commands
- extension tools
- extension UI context
- session lifecycle events
- `sendUserMessage`
- model/session/settings access
- tool-call and message events
- resource discovery
- shutdown/reload/session replacement hooks

If Pino is adapted from `pi-coding-agent`, most of this remains native. Extensions like `pi-telegram` are much more likely to work with minimal changes.

## Telegram extension viability

`pi-telegram` is a Pi extension, not a generic `pi-agent-core` plugin. It uses extension features such as:

- `/telegram-setup`
- `/telegram-connect`
- `/telegram-disconnect`
- `/telegram-status`
- `telegram_attach` tool
- message streaming events
- session-local connection state
- UI prompts/notifications
- `sendUserMessage`-style behavior

A fork/adaptation of `pi-coding-agent` is the most direct way to make it work.

Possible issue: some versions of `pi-telegram` reference older package names (`@mariozechner/...`) while the installed Pi here uses `@earendil-works/...`. That may require aliases, dependency alignment, or a small compatibility patch.

## Tool restriction

This option can still keep Pino minimal in behavior.

`pi-coding-agent` SDK supports explicit tool selection and disabling built-ins:

```ts
createAgentSession({
  tools: ["read", "bash", "delegate_task", "telegram_attach"],
});
```

Or:

```ts
createAgentSession({
  noTools: "all",
});
```

Or:

```ts
createAgentSession({
  noTools: "builtin",
  customTools: [delegateTaskTool],
});
```

In a fork, we can make that policy the default rather than a wrapper-level configuration.

## Slash commands

Because this option owns the app layer, we can remove, hide, or gate slash commands more deeply.

This matters because Pino wants a rich coding-agent interface but not necessarily Pi's full out-of-box command surface.

Possible policy:

- keep essential commands: model, settings, session, quit
- hide or remove commands that are too Pi-specific
- keep extension commands, since Telegram and future integrations may rely on them
- add Pino-native commands for background agents

## Advantages

- Best path to a full rich coding-agent interface.
- Best extension compatibility.
- Best chance that `pi-telegram` works naturally.
- Maximum control over branding, config directories, defaults, and commands.
- Can remove unwanted Pi features at the source.
- Pino can become a coherent product rather than a wrapper around Pi.

## Disadvantages

- Higher maintenance burden.
- We inherit a large codebase.
- We must track upstream Pi changes manually.
- Rebranding can become tedious if user-facing strings/config assumptions are spread out.
- More initial setup than a wrapper.
- More risk of drifting from upstream extension compatibility if we modify internals too aggressively.

## Risk profile

Main risk: fork maintenance.

If Pino diverges substantially from Pi, upstream fixes to providers, extensions, TUI, session handling, and settings may become harder to absorb.

Mitigation:

- keep the fork as shallow as possible
- isolate Pino changes in thin modules where possible
- avoid changing extension API shapes unless absolutely necessary
- keep upstream package boundaries intact
- prefer default configuration changes over deep rewrites

## Best fit

Choose Option 1 if:

- Pino should become a first-class standalone coding-agent app.
- We care about owning the UX deeply.
- We want to curate/remove built-in commands and features at the app layer.
- We expect long-term Pino-specific behavior to exceed what a wrapper can comfortably control.

---

# Option 2: Wrap `pi-coding-agent` with a Pino CLI

## Summary

Under this option, Pino is a custom CLI that imports `pi-coding-agent` SDK/run modes and configures them. It does not fork the app at first. It creates a runtime, controls defaults, restricts tools, loads Pino-specific extensions/tools, and then runs Pi's existing interactive mode.

This is the "Pino as a curated launcher/controller for Pi" approach.

## What we would reuse

Directly from `pi-coding-agent`:

- `createAgentSessionRuntime`
- `createAgentSessionServices`
- `createAgentSessionFromServices`
- `InteractiveMode`
- `runPrintMode`
- `runRpcMode`
- `DefaultResourceLoader`
- `SettingsManager`
- `SessionManager`
- `AuthStorage`
- `ModelRegistry`
- extension loading
- custom tools
- restricted built-in tools

The SDK explicitly supports running the full interactive mode programmatically:

```ts
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: undefined,
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

Pino would replace `getAgentDir()` and runtime setup with its own choices.

## What we would control

A wrapper can control quite a lot:

- binary name: `pino`
- custom `agentDir`, e.g. `~/.pino/agent`
- custom cwd/session strategy
- custom settings manager
- custom resource loader
- custom system prompt
- explicitly selected tools
- disabled built-in tools
- added custom tools, especially delegation/background-agent tools
- extension paths/packages to load
- initial message(s)
- print/RPC/interactive entrypoints

## Tool restriction

This is straightforward with the SDK:

```ts
createAgentSession({
  tools: ["read", "bash", "delegate_task"],
});
```

Or disable all defaults:

```ts
createAgentSession({
  noTools: "all",
});
```

Or disable built-ins but keep custom/extension tools:

```ts
createAgentSession({
  noTools: "builtin",
  customTools: [delegateTaskTool],
});
```

For Pino's first version, a good default might be:

```ts
tools: [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "delegate_task",
  "telegram_attach"
]
```

Then decide separately whether editing tools are enabled by default.

## Extension compatibility

This option preserves Pi extension compatibility because it still uses `pi-coding-agent`'s extension architecture.

That means `pi-telegram` is much more plausible than with a pure `pi-agent-core` build.

The wrapper can load extension packages by:

- setting Pino's `agentDir` and settings package list
- passing extension paths through a `DefaultResourceLoader`
- using the same package conventions as Pi

## Telegram extension viability

This option is likely sufficient for `pi-telegram`.

Because `InteractiveMode` and the session runtime already know how to bind extensions, extension UI, extension commands, and extension tools, Pino does not need to rebuild that compatibility layer.

The main work would be:

- ensure the Telegram extension package resolves against the package names/versions Pino uses
- decide whether Pino auto-loads it or asks the user to install/configure it
- decide where Telegram config should live (`~/.pino/agent/telegram.json` vs Pi's default path)

The last point may require patching or configuring `pi-telegram`, because its current README says it stores config in `~/.pi/agent/telegram.json`. If we want true Pino isolation, we may need a Pino-specific Telegram package or a small upstreamable option to respect the active agent dir.

## Slash commands

This is the weaker part of Option 2.

`InteractiveMode` includes Pi's built-in commands. A wrapper can configure resources and extensions, but it may not be able to deeply remove built-in slash commands without forking or patching internals.

However, the stated requirement is not "no slash commands". It is "we don't need all the features like slash commands out of the box per se." That means Option 2 is still viable if we can tolerate built-in commands being present initially.

Possible policy:

- accept Pi built-in commands for v0
- hide/discourage them through Pino docs and defaults
- add Pino commands for background-agent workflows
- later fork or patch `InteractiveMode` if command pruning becomes important

## UI customization

A wrapper can use the existing rich UI, but deep visual/product changes are harder.

Likely easy:

- startup prompt/message
- loaded resources
- theme selection if using standard theme machinery
- model/settings defaults
- extension widgets/status

Likely harder without forking:

- removing built-in command implementations
- changing all Pi labels to Pino
- changing layout deeply
- changing footer/header semantics beyond exposed extension UI hooks
- removing entire feature families from the UI

## Advantages

- Fastest route to a rich coding-agent interface.
- Reuses a working, tested app layer.
- Keeps extension compatibility.
- Avoids rebuilding TUI/session/auth/settings machinery.
- Lets us focus first on Pino's differentiator: background-agent delegation.
- Lower initial maintenance burden than a fork.
- Easy to later fork once we understand what must change.

## Disadvantages

- Less control over built-in UI behavior.
- Built-in slash commands and Pi assumptions may remain visible.
- Branding may be incomplete.
- Some config paths/extensions may still assume Pi unless carefully configured.
- Pino may feel like a Pi distribution rather than a distinct agent.
- Deep changes eventually force Option 1 anyway.

## Risk profile

Main risk: hidden coupling to Pi defaults.

A wrapper may look clean at the entrypoint but still inherit assumptions about commands, package locations, config names, startup notices, or UI labels.

Mitigation:

- set `agentDir` explicitly from day one
- use explicit settings/resource loader configuration
- keep a list of visible Pi-isms
- only fork when the list contains blockers, not cosmetic issues

## Best fit

Choose Option 2 if:

- we want a rich usable coding-agent interface quickly
- extension compatibility matters now
- `pi-telegram` should work soon
- the first unique Pino feature is delegation, not UI redesign
- we can tolerate Pi's built-in command surface temporarily

---

# Direct comparison

| Criterion | Option 1: adapt/fork coding-agent | Option 2: wrap coding-agent |
| --- | --- | --- |
| Time to rich UI | Medium | Fast |
| Extension compatibility | Strong | Strong |
| `pi-telegram` viability | Strong | Strong, with config/path caveats |
| Control over built-in commands | High | Medium/low |
| Control over branding | High | Medium |
| Maintenance burden | High | Low/medium |
| Upstream update ease | Harder | Easier |
| Ability to restrict tools | High | High |
| Ability to add background agents | High | High |
| Product distinctness | High | Medium initially |
| Risk of rebuilding existing features | Low | Low |
| Risk of hidden Pi assumptions | Medium | High |

---

# Recommendation

Start with **Option 2: wrap `pi-coding-agent`**, but design the wrapper so it can graduate into Option 1 later.

Reasoning:

1. Pino wants a full rich coding-agent interface.
2. `pi-coding-agent` already has that interface.
3. Pino wants extension compatibility.
4. `pi-coding-agent` already has the extension architecture.
5. Pino's differentiator is not initially the TUI; it is speed, delegation, and background-agent workflows.
6. Tool restriction and custom tools are already supported by the SDK.
7. We can validate the product shape before taking on fork maintenance.

In other words: use Pi's full app as a substrate first, not as the identity of the product forever.

## Recommended phased plan

### Phase 1: Pino wrapper

Create a `pino` CLI that:

- uses `@earendil-works/pi-coding-agent`
- sets a Pino-specific agent dir
- runs `InteractiveMode`
- applies a Pino system prompt
- restricts default tools
- adds a first `delegate_task` custom tool
- optionally loads `pi-telegram`

Goal: get a useful rich interface quickly.

### Phase 2: Pino defaults and extension compatibility

Add:

- Pino settings defaults
- Pino resource/package locations
- minimal Pino docs
- Telegram setup path decision
- background-agent status UI via extension widgets or messages
- clear tool policy

Goal: make Pino feel intentional rather than a bare wrapper.

### Phase 3: Background-agent architecture

Build Pino's real differentiator:

- background agent manager
- spawn/cancel/status/result APIs
- parent/child session linkage
- delegation tool
- result summarization
- UI/Telegram notifications

Goal: prove Pino's speed/delegation model.

### Phase 4: Decide whether to fork

After living with the wrapper, decide whether the remaining friction is worth Option 1.

Fork/adapt if we need:

- deep command pruning
- full branding
- changed session semantics
- changed extension API
- custom TUI layout
- removal of large feature families

Stay wrapper-based if:

- custom tools/extensions give enough control
- built-in Pi UI is acceptable
- upstream compatibility remains valuable

## Design principle

Do not fork just to make Pino feel pure. Fork only when the wrapper prevents an important product behavior.

The wrapper path gives us the rich interface and extension ecosystem immediately. Pino-specific energy should go first into delegation and background agents, because that is the intended difference.
