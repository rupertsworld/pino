# Pino principles

## User control over magic

Pino should prefer visible, inspectable mechanisms over hidden behavior. If something shapes how the agent behaves, the user should be able to find it, read it, and change it.

The system should warn rather than silently invent important behavior. Small fallbacks are acceptable when needed to keep the agent running, but the normal path should be user-owned files and explicit settings.

## Explicit composition

Pino should compose capabilities through clear pieces:

- prompt files for instructions;
- settings for package state and runtime configuration;
- skills for workflow guidance;
- extensions for agent-native runtime integration;
- MCP servers or CLIs for portable external capabilities.

Pino should avoid accidental inheritance from unrelated global state. Capabilities should be present because Pino ships them, the user configured them, or a visible package/resource declares them.

## Lean but extensible

Pino should keep the core small. New capabilities should live outside the kernel unless they are truly part of the harness itself.

The kernel should focus on state layout, resource policy, sandboxing, process/session lifecycle, and eventually background-agent orchestration. Everything else should be added through composable packages, skills, extensions, MCP servers, or CLIs.
