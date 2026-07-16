import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { RpcError, type MethodHandler } from "@pino-agent/transport";
import { MODEL_NOT_FOUND, PROVIDER_NOT_CONFIGURED, RESPONSE_FAILED, ABORTED } from "./error-codes.ts";
import { redactSecrets } from "../redact.ts";

// --- wire shapes: explicit projections, never spreads ------------------------

/** inference.md Usage — exact field list; anything pi-ai adds later is dropped. */
function stripUsage(u: Usage): Usage {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    ...(u.cacheWrite1h === undefined ? {} : { cacheWrite1h: u.cacheWrite1h }),
    ...(u.reasoning === undefined ? {} : { reasoning: u.reasoning }),
    totalTokens: u.totalTokens,
    cost: {
      input: u.cost.input,
      output: u.cost.output,
      cacheRead: u.cost.cacheRead,
      cacheWrite: u.cost.cacheWrite,
      total: u.cost.total,
    },
  };
}

function stripBlock(
  block: AssistantMessage["content"][number],
): AssistantMessage["content"][number] | undefined {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
        ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    case "toolCall":
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments, // JSON object, carried verbatim
        ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
      };
    default:
      // a block type outside the vendored union (buggy/custom provider):
      // dropped, because emitting it (or null) would violate the wire shape
      // — inference.md: content is (Text|Thinking|ToolCall)[]
      return undefined;
  }
}

/**
 * inference.md AssistantMessage — the wire carries EXACTLY these fields.
 * "pi-ai's per-message diagnostics field is deliberately excluded: the
 * gateway strips it — and any other non-schema field — from everything it
 * sends on the wire." Optional fields are omitted when absent, never null.
 */
export function stripAssistantMessage(m: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: m.content.map(stripBlock).filter((b) => b !== undefined),
    api: m.api,
    provider: m.provider,
    model: m.model,
    ...(m.responseModel === undefined ? {} : { responseModel: m.responseModel }),
    ...(m.responseId === undefined ? {} : { responseId: m.responseId }),
    usage: stripUsage(m.usage),
    stopReason: m.stopReason,
    ...(m.errorMessage === undefined ? {} : { errorMessage: m.errorMessage }),
    timestamp: m.timestamp,
  };
}

/** inference.md respondEvent union — the bandwidth-stripped wire form of
 * pi-ai's stream events (the same translation pi's own proxy performs). */
type WireRespondEvent =
  | { type: "start" }
  | { type: "text_start" | "thinking_start" | "toolcall_end"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string };

/**
 * pi-ai event → wire event: drop the per-event `partial` snapshot; lift
 * id/toolName (toolcall_start) and contentSignature (text_end/thinking_end)
 * from the partial's block at contentIndex. Terminals return undefined —
 * "there are no terminal event types on the wire: termination is the
 * `respond` response itself."
 */
function toWireEvent(event: AssistantMessageEvent): WireRespondEvent | undefined {
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
    case "thinking_start":
    case "toolcall_end":
      return { type: event.type, contentIndex: event.contentIndex };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_end": {
      const block = event.partial.content[event.contentIndex];
      const sig = block?.type === "text" ? block.textSignature : undefined;
      return { type: "text_end", contentIndex: event.contentIndex, ...(sig === undefined ? {} : { contentSignature: sig }) };
    }
    case "thinking_end": {
      const block = event.partial.content[event.contentIndex];
      const sig = block?.type === "thinking" ? block.thinkingSignature : undefined;
      return { type: "thinking_end", contentIndex: event.contentIndex, ...(sig === undefined ? {} : { contentSignature: sig }) };
    }
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      const call = block !== undefined && block.type === "toolCall" ? block : undefined;
      // a partial without the block would be a provider bug; empty strings
      // keep the wire shape intact rather than dropping the event
      return { type: "toolcall_start", contentIndex: event.contentIndex, id: call?.id ?? "", toolName: call?.name ?? "" };
    }
    case "done":
    case "error":
      return undefined;
  }
}

// --- options: the inference.md subset, explicitly projected -------------------

const REASONING_LEVELS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const CACHE_RETENTIONS: readonly string[] = ["none", "short", "long"];

/** inference.md Options is a closed subset of pi-ai's stream options; the
 * projection is exact so wire callers cannot smuggle pi-ai-only options
 * (apiKey, callbacks, retry settings) through the gateway. */
function wireOptions(raw: unknown): SimpleStreamOptions {
  const o = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    ...(typeof o.temperature === "number" ? { temperature: o.temperature } : {}),
    ...(typeof o.maxTokens === "number" ? { maxTokens: o.maxTokens } : {}),
    ...(typeof o.reasoning === "string" && REASONING_LEVELS.includes(o.reasoning)
      ? { reasoning: o.reasoning as SimpleStreamOptions["reasoning"] }
      : {}),
    ...(typeof o.cacheRetention === "string" && CACHE_RETENTIONS.includes(o.cacheRetention)
      ? { cacheRetention: o.cacheRetention as SimpleStreamOptions["cacheRetention"] }
      : {}),
    ...(typeof o.sessionId === "string" ? { sessionId: o.sessionId } : {}),
  };
}

// --- failed-turn logging -------------------------------------------------------

function defaultLog(line: string): void {
  process.stderr.write(`pino-gateway: ${line}\n`);
}

/** gateway.md: "Failed turns are logged to stderr — error message and
 * diagnostics — with request bodies never logged and known secret patterns
 * redacted." One line per failed turn; the context never appears here.
 * `extraSecrets` carries stored-credential values (slice C carry-over): non
 * sk-shaped tokens no pattern or env scan would catch. */
function logFailedTurn(
  log: (line: string) => void,
  model: Model<Api>,
  final: AssistantMessage,
  extraSecrets: Iterable<string>,
): void {
  // aborted turns (user cancel, disconnect) are logged too, but not as
  // failures — misleading noise otherwise
  const verb = final.stopReason === "aborted" ? "respond aborted" : "respond failed";
  const parts = [`${verb} (${model.provider}/${model.id}): ${final.errorMessage ?? final.stopReason}`];
  if (final.diagnostics !== undefined && final.diagnostics.length > 0) {
    const summary = final.diagnostics
      .map((d) => (d.error?.message === undefined ? d.type : `${d.type}: ${d.error.message}`))
      .join("; ");
    parts.push(`diagnostics: ${summary}`);
  }
  log(redactSecrets(parts.join(" — "), extraSecrets));
}

// --- handlers --------------------------------------------------------------------

export interface RespondHandlers {
  respond: MethodHandler;
  cancel: MethodHandler;
}

/**
 * `respond` (request) and `cancel` (notification). The in-flight-request
 * lifecycle — the no-reuse-id rule, the per-request abort signal, and
 * connection-close-aborts-all — is owned by the transport server
 * ([[transport.md]]), not here: `respond` reads its request's `AbortSignal`
 * from the handler context and registers nothing; `cancel` aborts by id
 * through the connection.
 */
export function makeRespondHandlers(
  models: Models,
  log: (line: string) => void = defaultLog,
  extraSecrets: () => Iterable<string> = () => [],
): RespondHandlers {
  const respond: MethodHandler = async (params, conn, ctx) => {
    const id = ctx.id;
    // respondEvent correlation needs a concrete request id (inference.md); the
    // server already rejects a reused in-flight id centrally, so this only
    // guards the shape.
    if (typeof id !== "number" && typeof id !== "string") {
      throw new RpcError(-32600, "invalid request: respond requires a request id");
    }

    const p = (params !== null && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const ref = (p.model !== null && typeof p.model === "object" ? p.model : {}) as Record<string, unknown>;
    if (typeof ref.provider !== "string" || typeof ref.id !== "string") {
      throw new RpcError(-32602, "invalid params: model {provider, id} is required");
    }
    const context = p.context;
    if (context === null || typeof context !== "object" || !Array.isArray((context as { messages?: unknown }).messages)) {
      throw new RpcError(-32602, "invalid params: context with a messages array is required");
    }

    // inference.md error 1: "respond with unknown provider/model"
    const model = models.getModel(ref.provider, ref.id);
    if (model === undefined) {
      throw new RpcError(MODEL_NOT_FOUND, `model not found: ${ref.provider}/${ref.id}`);
    }

    // inference.md error 2: "respond without resolvable auth". getAuth may
    // refresh a stored OAuth token — acceptable in the respond path, the
    // request needs it anyway. A getAuth REJECTION is an auth-system
    // failure (refresh failed, store broken): still code 2, message kept.
    // Accepted race: this preflight and streamSimple's own resolve are separate
    // reads; a same-user logout landing between them surfaces as response_failed
    // (3) rather than provider_not_configured (2). Narrow and benign — not worth
    // restructuring the auth flow to make the two resolves atomic.
    let auth;
    try {
      auth = await models.getAuth(model);
    } catch (err) {
      throw new RpcError(
        PROVIDER_NOT_CONFIGURED,
        // pi-ai's ModelsError messages are fixed templates (cause never
        // serialized), so this is hardening, not a known leak
        redactSecrets(err instanceof Error ? err.message : String(err), extraSecrets()),
      );
    }
    if (auth === undefined) {
      throw new RpcError(PROVIDER_NOT_CONFIGURED, `provider not configured: ${ref.provider}`);
    }

    // gateway.md: "Every model request runs with an abort signal honoring
    // cancel and connection drop, and an explicit retry bound (pi-ai's
    // Anthropic implementation performs no retries by default)." The signal is
    // the transport server's per-request AbortSignal: `cancel` and connection
    // drop both abort it, without respond tracking anything.
    const options: SimpleStreamOptions = { ...wireOptions(p.options), signal: ctx.signal, maxRetries: 2 };
    const stream = models.streamSimple(model, context as Context, options);

    // Draining the stream to completion before returning guarantees the
    // correlation rule: "The gateway sends every respondEvent for a request
    // before that request's terminating response" — both go out the same
    // socket, in this order.
    for await (const event of stream) {
      const wire = toWireEvent(event);
      if (wire !== undefined) conn.notify("respondEvent", { requestId: id, event: wire });
    }

    // gateway.md: "pi-ai streams never throw; this mapping is the only
    // failure path" — result() resolves the final message on success AND
    // failure, and stopReason is the branch.
    const final = await stream.result();
    if (final.stopReason === "stop" || final.stopReason === "length" || final.stopReason === "toolUse") {
      return { message: stripAssistantMessage(final) };
    }
    const secrets = extraSecrets();
    logFailedTurn(log, model, final, secrets);
    const code = final.stopReason === "aborted" ? ABORTED : RESPONSE_FAILED;
    // judgment call: a failure that produced nothing (no content, zero
    // usage) omits partialMessage — there is nothing to push back into a
    // context, and inference.md marks the field optional
    const partial = stripAssistantMessage(final);
    // gateway.md: "Credentials never leave the gateway outbound." A provider
    // error can echo an API key / OAuth token, and stripAssistantMessage copies
    // errorMessage verbatim — so redact ONCE (env + stored-credential secrets)
    // and use it for BOTH the wire error message AND partialMessage.errorMessage.
    const message = redactSecrets(final.errorMessage ?? (code === ABORTED ? "aborted" : "response failed"), secrets);
    if (partial.errorMessage !== undefined) partial.errorMessage = redactSecrets(partial.errorMessage, secrets);
    const data =
      partial.content.length === 0 && final.usage.totalTokens === 0 ? undefined : { partialMessage: partial };
    throw new RpcError(code, message, data);
  };

  // inference.md cancel: notification — "abort the in-flight respond with
  // that id"; the gateway "ignores cancel of ids not currently in flight".
  // The transport server owns the in-flight registry, so cancel just asks the
  // connection to abort by id (a no-op for an id not in flight).
  const cancel: MethodHandler = (params, conn) => {
    const p = (params !== null && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const requestId = p.requestId;
    if (typeof requestId !== "number" && typeof requestId !== "string") return;
    conn.abortInbound(requestId);
  };

  return { respond, cancel };
}
