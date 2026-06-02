# Pi core components

This document is a working map of the lower-level Pi packages that `pino` should build on.

`pino` is intended to be a bare-minimal, fast agent harness focused on orchestration and heavy use of background agents. The goal is to reuse Pi's model and agent primitives without inheriting the full `pi-coding-agent` application layer.

## Package stack

Pi is split into several packages:

| Package | Role | Likely use in `pino` |
| --- | --- | --- |
| `@earendil-works/pi-ai` | Provider/model abstraction and streaming LLM API | Core dependency |
| `@earendil-works/pi-agent-core` | Stateful agent loop, tool execution, events, queues, session helpers | Main runtime |
| `@earendil-works/pi-tui` | Terminal UI toolkit | Optional later |
| `@earendil-works/pi-coding-agent` | Full coding-agent app: CLI, TUI, extensions, skills, built-in tools, sessions, RPC | Reference only initially |

The important distinction is that `pi-coding-agent` is the full app. `pino` should start below that layer, using `pi-ai` and `pi-agent-core` directly.

```txt
pino CLI / daemon
  ├─ pi-agent-core Agent
  │   ├─ pi-ai model/provider streaming
  │   ├─ transcript state
  │   ├─ tool execution
  │   ├─ event stream
  │   └─ steering/follow-up queues
  ├─ custom background-agent manager
  ├─ custom session/log storage
  └─ optional pi-tui interface later
```

## Is Pi fast enough?

Likely yes.

Most agent latency comes from model calls, tool I/O, tests, shell commands, git operations, network calls, and context size. The JavaScript/TypeScript runtime overhead is probably not the limiting factor for `pino`.

Node/TypeScript is a good first choice because:

- Pi's reusable internals are already TypeScript packages.
- Provider streaming, Telegram, subprocesses, and background agents are I/O-heavy.
- Node's async runtime fits orchestration well.
- `pi-agent-core` already supports parallel tool execution.
- Reimplementing provider/model handling in Go would discard a lot of existing work.

Go might become attractive later if measured problems appear around startup time, memory footprint, static-binary distribution, daemon reliability, or very high concurrency. Even then, a hybrid design may be better: a Go supervisor with TypeScript Pi worker processes.

For now: build `pino` in TypeScript, reuse Pi core packages, and profile before considering a rewrite.

---

# `@earendil-works/pi-ai`

## Purpose

`pi-ai` is the lowest-level LLM abstraction. It normalizes model metadata, provider APIs, streaming events, tool-call schemas, image input, thinking/reasoning, token usage, and costs.

It does not run an autonomous agent loop. It performs one model request at a time and returns or streams one assistant message.

## Responsibilities

`pi-ai` provides:

- model lookup and provider metadata
- unified streaming and non-streaming completion APIs
- provider-specific adapters
- text, image, thinking, tool-call, and tool-result message types
- TypeBox-based tool schemas
- tool-call validation helpers
- usage and cost accounting
- provider compatibility shims
- cross-provider message handoff behavior
- image-generation APIs, separate from chat/tool calling
- faux providers for deterministic tests

## Architecture

```txt
Model metadata
  ↓
Context { systemPrompt, messages, tools }
  ↓
stream(model, context, options)
  ↓
provider-specific adapter
  ↓
AssistantMessageEvent stream
  ↓
AssistantMessage final result
```

Provider adapters translate different upstream APIs into the same Pi event protocol. Built-in APIs include Anthropic Messages, OpenAI Responses, OpenAI-compatible Chat Completions, Google Gemini, Vertex, Bedrock, Mistral, and others.

## Key interfaces

### `Model`

A `Model` describes a concrete model and how to call it.

```ts
interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: unknown;
}
```

Important fields for `pino`:

- `provider` and `id`: identity.
- `api`: which provider adapter to use.
- `reasoning`: whether thinking controls are supported.
- `input`: whether image input is supported.
- `contextWindow`: useful for compaction and routing decisions.
- `maxTokens`: output cap.
- `cost`: accounting and routing.
- `compat`: custom behavior for OpenAI-compatible or Anthropic-compatible servers.

### Model lookup

```ts
getProviders(): KnownProvider[]
getModels(provider): Model[]
getModel(provider, modelId): Model
getSupportedThinkingLevels(model): ModelThinkingLevel[]
clampThinkingLevel(model, level): ModelThinkingLevel
```

For a minimal harness, `pino` can start with explicit model selection by provider/model id, then add config and model cycling later.

### `Context`

```ts
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

This is the request sent to the model. `pi-agent-core` builds this from its richer `AgentContext`.

### Messages

```ts
type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

User message:

```ts
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

Assistant message:

```ts
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}
```

Tool result message:

```ts
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
```

Content blocks:

```ts
interface TextContent {
  type: "text";
  text: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### Tools

```ts
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

Tools are declared with TypeBox schemas. `pi-ai` describes tools and validates tool-call arguments, but it does not execute tools. Tool execution belongs to the caller or to `pi-agent-core`.

### Streaming

Core APIs:

```ts
stream(model, context, options?)
complete(model, context, options?)
streamSimple(model, context, options?)
completeSimple(model, context, options?)
```

`streamSimple` / `completeSimple` provide a normalized `reasoning` option:

```ts
interface SimpleStreamOptions extends StreamOptions {
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
  thinkingBudgets?: ThinkingBudgets;
}
```

Streaming events include:

- `start`
- `text_start`
- `text_delta`
- `text_end`
- `thinking_start`
- `thinking_delta`
- `thinking_end`
- `toolcall_start`
- `toolcall_delta`
- `toolcall_end`
- `done`
- `error`

Consumers must use `contentIndex` to associate streaming deltas with content blocks. Text, thinking, and tool-call deltas may interleave.

## Error and abort behavior

Provider/runtime failures are represented as final assistant messages with:

```ts
stopReason: "error" | "aborted"
errorMessage?: string
```

Streaming emits an `error` event, and the final result still exists. This makes it possible to preserve partial content and continue later.

## Cross-provider handoff

`pi-ai` can transform messages from one provider/API to another. Standard user and tool-result messages pass through. Assistant messages from different providers may have thinking blocks converted to text with `<thinking>` tags while preserving ordinary text and tool calls.

This matters for `pino` because background agents may use different models than the foreground controller.

## Relevance to `pino`

Use `pi-ai` for:

- model/provider registry
- custom model definitions
- direct provider streaming when needed
- message and tool-call types
- usage and cost accounting
- faux providers in tests

Do not reimplement provider adapters unless there is a clear reason.

---

# `@earendil-works/pi-agent-core`

## Purpose

`pi-agent-core` is the minimal stateful agent runtime built on `pi-ai`.

It owns the transcript, calls the model, executes tools, emits events, supports steering/follow-up queues, and exposes hooks around tool execution and turn progression.

This should be the main runtime package for `pino`.

## Responsibilities

`pi-agent-core` provides:

- `Agent` class
- low-level `agentLoop` and `agentLoopContinue`
- stateful message transcript
- model and thinking-level state
- tool registration and execution
- parallel/sequential tool execution
- streaming lifecycle events
- abort handling
- steering and follow-up queues
- custom message support
- context transformation before model calls
- hooks before and after tool execution
- optional session and compaction helpers

## Architecture

```txt
Agent.prompt(user input)
  ↓
append user message
  ↓
agent_start
  ↓
turn_start
  ↓
convert AgentMessage[] to LLM Message[]
  ↓
pi-ai streamSimple(model, context)
  ↓
assistant message
  ↓
if tool calls:
  ├─ validate tool arguments
  ├─ beforeToolCall hook
  ├─ execute AgentTool(s)
  ├─ afterToolCall hook
  ├─ append toolResult messages
  └─ continue with another model turn
  ↓
if no tool calls:
  ├─ drain steering queue if present
  ├─ drain follow-up queue if present
  └─ otherwise finish
  ↓
agent_end
```

## `Agent`

Minimal usage:

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    thinkingLevel: "off",
  },
});

agent.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello");
```

## Agent options

Important constructor options:

```ts
interface AgentOptions {
  initialState?: Partial<AgentState>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  prepareNextTurn?: (...) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  toolExecution?: "parallel" | "sequential";
}
```

For `pino`, the most important options are:

- `initialState`
- `convertToLlm`
- `transformContext`
- `getApiKey`
- `beforeToolCall`
- `afterToolCall`
- `prepareNextTurn`
- `toolExecution`

## Agent state

```ts
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

`AgentState` is mutable. Assigning new `tools` or `messages` arrays copies the top-level array. Mutating the returned array mutates current state.

## `AgentMessage` and custom messages

```ts
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

This is one of the most important design points. `pi-agent-core` can store richer app messages than the model can see.

`pino` could define custom message types for:

- background-agent started
- background-agent progress
- background-agent result
- user-interface notifications
- delegation decisions
- task state changes
- artifacts
- external events from Telegram or other adapters

Only model-compatible messages should be sent to the LLM. That mapping happens in `convertToLlm`.

```ts
convertToLlm: (messages) => messages.flatMap((message) => {
  if (message.role === "background_status") return [];
  if (message.role === "background_result") {
    return [{
      role: "user",
      content: `Background result: ${message.summary}`,
      timestamp: message.timestamp,
    }];
  }
  return [message];
})
```

## Context transformation

`transformContext` runs before conversion to LLM messages.

Use it for:

- pruning old messages
- compaction
- injecting external state
- hiding noisy background-agent events
- converting long logs into summaries

```ts
transformContext: async (messages, signal) => {
  return pruneOrSummarize(messages);
}
```

## Tools

```ts
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
  extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}
```

Tool results:

```ts
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}
```

Important conventions:

- Throw from tools on failure. Do not encode failure as ordinary successful content.
- Use `onUpdate` for streaming progress.
- `terminate: true` can skip automatic follow-up if every tool result in the batch terminates.
- A tool can force `executionMode: "sequential"`.

## Parallel tool execution

Agent tool execution mode is configurable:

```ts
toolExecution: "parallel" | "sequential"
```

Default is parallel.

In parallel mode:

1. tool calls are preflighted sequentially
2. allowed tools execute concurrently
3. `tool_execution_end` events emit in completion order
4. persisted tool-result messages remain in assistant source order

This is directly relevant to `pino`'s speed goal.

## Hooks

### `beforeToolCall`

Runs after tool-call arguments are validated, before execution.

Can block a tool:

```ts
return { block: true, reason: "not allowed" };
```

Potential `pino` uses:

- permission checks
- routing delegation tools
- rate limits
- sandbox policy
- audit logging

### `afterToolCall`

Runs after tool execution, before final tool events and messages are emitted.

Can override:

```ts
interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}
```

Potential `pino` uses:

- attach metadata
- redact output
- summarize long results
- mark delegation tools as terminal

### `prepareNextTurn`

Can replace context, model, or thinking level before another turn.

Potential `pino` uses:

- switch to cheaper/faster model after tool results
- stop or reroute after background-agent completion
- inject compaction output

## Events

Agent events:

```ts
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

`Agent.subscribe()` listeners are awaited in registration order. `agent_end` is the final event, but the agent is not fully idle until `agent_end` listeners settle.

For `pino`, this event stream can power:

- stdout streaming
- logs
- Telegram streaming
- background-agent dashboards
- session persistence
- metrics

## Steering and follow-up queues

```ts
agent.steer(message)
agent.followUp(message)
```

Steering messages are injected after the current assistant turn finishes executing tools.

Follow-up messages run after the agent would otherwise stop.

Queue modes:

```ts
"one-at-a-time" | "all"
```

This is useful for interfaces where input can arrive while the agent is busy, especially Telegram and background agents.

Possible policy:

- urgent user interruption: `steer`
- ordinary queued user message: `followUp`
- background worker result: likely `steer` if relevant to active task, otherwise custom message + follow-up

## Low-level API

`pi-agent-core` also exposes low-level loops:

```ts
agentLoop(prompts, context, config)
agentLoopContinue(context, config)
```

These produce event streams directly. The docs recommend `Agent` when event handling needs to act as a barrier before later phases like tool preflight.

`pino` should start with `Agent`, not raw `agentLoop`.

## Session and compaction helpers

`pi-agent-core` exports some harness utilities that sit between core and the full coding-agent app:

- JSONL and memory session repos
- `Session`
- compaction helpers
- prompt-template helpers
- skills helpers
- system-prompt formatting helpers

The session class supports tree-like entries and operations such as:

```ts
appendMessage(message)
appendThinkingLevelChange(thinkingLevel)
appendModelChange(provider, modelId)
appendCompaction(summary, firstKeptEntryId, tokensBefore, details)
appendCustomEntry(customType, data)
appendCustomMessageEntry(customType, content, display, details)
appendLabel(targetId, label)
appendSessionName(name)
moveTo(entryId, summary?)
buildContext()
```

For `pino`, these are worth evaluating, but not mandatory for the first CLI. A minimal append-only log may be enough initially.

## Relevance to `pino`

`pino` should probably wrap `Agent` in a small controller:

```txt
PinoController
  ├─ Agent
  ├─ SessionStore
  ├─ BackgroundAgentManager
  ├─ ModelConfig
  └─ Interface adapters
      ├─ CLI
      ├─ Telegram later
      └─ TUI later
```

Most `pino` behavior should be implemented around these extension points:

- `AgentTool`
- `AgentEvent`
- `convertToLlm`
- `transformContext`
- `steer`
- `followUp`
- `beforeToolCall`
- `afterToolCall`
- `prepareNextTurn`

---

# `@earendil-works/pi-tui`

## Purpose

`pi-tui` is a terminal UI framework. It is not agent-specific.

It provides a component model, differential rendering, synchronized terminal output, input handling, editor widgets, markdown rendering, overlays, autocomplete, and image rendering.

`pino` does not need this for the first headless or simple CLI version. It becomes useful if `pino` grows an interactive terminal interface.

## Responsibilities

`pi-tui` provides:

- terminal abstraction
- render loop
- differential rendering
- synchronized output for flicker-free updates
- component interface
- focus/input routing
- overlays
- single-line and multi-line editors
- markdown rendering
- selection/settings lists
- loaders
- slash-command and file-path autocomplete
- keyboard parsing
- inline image rendering
- virtual terminal for tests

## Architecture

```txt
Terminal implementation
  ↓
TUI
  ├─ child components
  ├─ focused component
  ├─ overlays
  └─ renderer
       ├─ first render
       ├─ full re-render when needed
       └─ differential update otherwise
```

## Key interfaces

### `Terminal`

```ts
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```

Built-ins:

- `ProcessTerminal`: real stdin/stdout
- `VirtualTerminal`: testing

### `Component`

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}
```

Each rendered line must fit within `width`. Components should use helpers like `truncateToWidth`, `visibleWidth`, and `wrapTextWithAnsi`.

### `Focusable`

```ts
interface Focusable {
  focused: boolean;
}
```

Focusable components use `CURSOR_MARKER` so the real terminal cursor can be placed correctly. This matters for IME support.

## Main components

- `TUI`
- `Container`
- `Box`
- `Text`
- `TruncatedText`
- `Input`
- `Editor`
- `Markdown`
- `Loader`
- `CancellableLoader`
- `SelectList`
- `SettingsList`
- `Spacer`
- `Image`

## `TUI`

The `TUI` object owns rendering and focus.

```ts
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.setFocus(component);
tui.requestRender();
tui.start();
tui.stop();
```

It also supports overlays:

```ts
const handle = tui.showOverlay(component, options);
handle.hide();
handle.focus();
handle.unfocus();
```

## Rendering model

`pi-tui` uses three strategies:

1. first render: output all lines
2. terminal width changed or change above viewport: clear and full re-render
3. normal update: move cursor to first changed line, clear to end, render changed lines

Updates are wrapped in synchronized output (`CSI ?2026h` / `CSI ?2026l`) so terminal changes appear atomically and with less flicker.

## Input model

Focused components receive raw terminal input through `handleInput(data)`.

Key helpers:

```ts
matchesKey(data, Key.ctrl("c"))
matchesKey(data, Key.enter)
matchesKey(data, Key.escape)
```

This avoids hand-parsing escape sequences.

## Editor

The `Editor` component is a multi-line text editor with:

- word wrapping
- slash-command autocomplete
- file-path autocomplete
- paste handling
- scrolling
- fake cursor rendering
- configurable theme

This would be the likely input widget if `pino` later gets an interactive TUI.

## Markdown

The `Markdown` component renders markdown with theme hooks for headings, links, code, code blocks, quotes, lists, bold, italic, etc. It also supports syntax highlighting through an optional `highlightCode` callback.

Useful for rendering assistant messages in an interactive UI.

## Relevance to `pino`

Defer `pi-tui` initially. A minimal fast harness can start with:

- `pino "prompt"`
- stdout streaming
- optional stdin loop

Add `pi-tui` when we need:

- persistent chat display
- model/status footer
- interactive command palette
- background-agent monitor
- rich keyboard shortcuts
- inline images

---

# How these pieces fit together for `pino`

## Minimal first architecture

```txt
CLI entrypoint
  ↓
load config / env
  ↓
getModel(provider, modelId)
  ↓
construct Agent
  ↓
register minimal tools
  ↓
subscribe to Agent events
  ↓
agent.prompt(input)
```

First version can avoid sessions, TUI, Telegram, and extensions.

## Background-agent architecture

The core `pino` feature should be a background delegation manager.

Conceptually:

```txt
Foreground Agent
  ├─ delegate_task tool
  │   └─ BackgroundAgentManager.spawn(task)
  │       ├─ creates child Agent
  │       ├─ runs in background
  │       ├─ streams events to log/status
  │       └─ returns summary/result/artifacts
  ├─ observes background results
  └─ decides whether to continue, steer, or summarize
```

Possible child-agent lifecycle:

```txt
queued → running → needs_input | completed | failed | cancelled
```

A delegation tool could return quickly with a background job id, or block until completion depending on task type. Since `pino` prioritizes background agents, the default should probably be non-blocking: spawn, return id, and let the foreground agent continue or poll.

## Important design questions for later

- Should background agents share the same transcript or have isolated transcripts?
- Should child-agent results enter the foreground context automatically?
- Should foreground agents be able to steer child agents?
- Should background agents have tools equal to, fewer than, or more than the parent?
- How should session storage represent parent/child relationships?
- Should delegation be a tool, a CLI primitive, or both?
- Should there be a scheduler/queue independent of any foreground agent?

## Recommended dependency stance

Start with:

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "^0.75.5",
    "@earendil-works/pi-agent-core": "^0.75.5",
    "typebox": "^1.1.38"
  }
}
```

Defer:

```json
{
  "@earendil-works/pi-tui": "later",
  "@earendil-works/pi-coding-agent": "reference only"
}
```

## Recommended first milestone

1. Create a minimal TypeScript CLI.
2. Select a model from config or environment.
3. Construct an `Agent`.
4. Stream `text_delta` events to stdout.
5. Add one trivial tool to verify tool execution.
6. Add a simple background-agent manager as the first real `pino` feature.

The first real `pino`-specific design should be delegation, not UI.
