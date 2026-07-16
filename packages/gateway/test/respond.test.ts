import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { makeRespondHandlers } from "../src/wire/respond.ts";
import { Client, connectClient, initHandler, onAbort, startWireServer, withTimeout } from "./helpers.ts";

// --- scripted provider: the test drives the AssistantMessageEventStream ----
// pi-ai's faux provider was evaluated first (dist/providers/faux.js) and
// rejected for this suite: it re-chunks scripted messages with Math.random
// sizing, offers no gate between events (cancel timing would be racy), and
// never emits text/thinking signatures. Hand-rolling the ProviderStreams
// gives exact, gateable event sequences.

interface ScriptedCall {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
  stream: AssistantMessageEventStream;
}

type AuthMode = "ok" | "unconfigured" | "explodes";

function scriptedFixture(authMode: AuthMode = "ok") {
  const calls: ScriptedCall[] = [];
  let served = 0;
  const callWaiters: ((call: ScriptedCall) => void)[] = [];
  const api: ProviderStreams = {
    stream(model, context, options) {
      return api.streamSimple(model, context, options);
    },
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const call: ScriptedCall = { model, context, ...(options === undefined ? {} : { options }), stream };
      calls.push(call);
      const waiter = callWaiters.shift();
      if (waiter) {
        served++;
        waiter(call);
      }
      return stream;
    },
  };
  const resolve =
    authMode === "ok"
      ? async () => ({ auth: { apiKey: "resolved-key" }, source: "test" })
      : authMode === "unconfigured"
        ? async () => undefined
        : async () => {
            throw new Error("keychain locked");
          };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "scripted",
      name: "Scripted",
      auth: { apiKey: { name: "Scripted key", resolve } },
      models: [
        {
          id: "scripted-1",
          name: "Scripted 1",
          api: "scripted-api",
          provider: "scripted",
          baseUrl: "http://localhost:0",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      api,
    }),
  );
  const logLines: string[] = [];
  const extraSecrets: string[] = [];
  return {
    models,
    calls,
    logLines,
    extraSecrets,
    nextCall(): Promise<ScriptedCall> {
      if (served < calls.length) return Promise.resolve(calls[served++]);
      return withTimeout(new Promise<ScriptedCall>((resolve) => callWaiters.push(resolve)), "provider call");
    },
  };
}

type Fixture = ReturnType<typeof scriptedFixture>;

// --- message builders -------------------------------------------------------

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    ...overrides,
  };
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function msg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "scripted-api",
    provider: "scripted",
    model: "scripted-1",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1111,
    ...overrides,
  };
}

/** Minimal complete turn for tests that only care about termination. */
function finishTurn(call: ScriptedCall, message: AssistantMessage): void {
  call.stream.push({ type: "start", partial: msg({ content: [] }) });
  call.stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
}

const MODEL_REF = { provider: "scripted", id: "scripted-1" };
const CONTEXT: Context = { messages: [{ role: "user", content: "hello there", timestamp: 1 }] };

async function connect(t: TestContext, f: Fixture): Promise<Client> {
  const { respond, cancel } = makeRespondHandlers(f.models, (line) => f.logLines.push(line), () => f.extraSecrets);
  const sockPath = await startWireServer(t, { initialize: initHandler(), respond, cancel });
  return connectClient(t, sockPath);
}

// --- happy path --------------------------------------------------------------

// inference.md respondEvent: the wire events are the bandwidth-stripped union
// (no `partial` snapshots, no terminal types — "termination is the respond
// response itself"), with contentSignature lifted from the partial's block on
// text_end/thinking_end. The result carries the full stripped final message.
test("respond: happy path streams exact stripped events, then the result", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const call = await f.nextCall();

  const thinking = { type: "thinking" as const, thinking: "mm", thinkingSignature: "tsig-1" };
  const text = { type: "text" as const, text: "Hello", textSignature: "sig-1" };
  call.stream.push({ type: "start", partial: msg({ content: [] }) });
  call.stream.push({ type: "thinking_start", contentIndex: 0, partial: msg({ content: [{ type: "thinking", thinking: "" }] }) });
  call.stream.push({ type: "thinking_delta", contentIndex: 0, delta: "mm", partial: msg({ content: [{ type: "thinking", thinking: "mm" }] }) });
  call.stream.push({ type: "thinking_end", contentIndex: 0, content: "mm", partial: msg({ content: [thinking] }) });
  call.stream.push({ type: "text_start", contentIndex: 1, partial: msg({ content: [thinking, { type: "text", text: "" }] }) });
  call.stream.push({ type: "text_delta", contentIndex: 1, delta: "Hel", partial: msg({ content: [thinking, { type: "text", text: "Hel" }] }) });
  call.stream.push({ type: "text_delta", contentIndex: 1, delta: "lo", partial: msg({ content: [thinking, { type: "text", text: "Hello" }] }) });
  call.stream.push({ type: "text_end", contentIndex: 1, content: "Hello", partial: msg({ content: [thinking, text] }) });
  const final = msg({ content: [thinking, text], responseModel: "scripted-1-v2", responseId: "resp-1" });
  call.stream.push({ type: "done", reason: "stop", message: final });

  const res = await resP;

  // exact stripped event lines, in order
  assert.deepEqual(c.events(2), [
    { type: "start" },
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "mm" },
    { type: "thinking_end", contentIndex: 0, contentSignature: "tsig-1" },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: "Hel" },
    { type: "text_delta", contentIndex: 1, delta: "lo" },
    { type: "text_end", contentIndex: 1, contentSignature: "sig-1" },
  ]);

  // correlation rule: "The gateway sends every respondEvent for a request
  // before that request's terminating response."
  const responseIdx = c.messages.findIndex((m) => m.id === 2 && "result" in m);
  const lastEventIdx = c.messages.map((m) => m.method === "respondEvent").lastIndexOf(true);
  assert.ok(lastEventIdx < responseIdx, "all respondEvents precede the response");

  // the result carries the full final assistant message, stripped to exactly
  // inference.md's AssistantMessage fields
  assert.deepEqual(res.result, {
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "mm", thinkingSignature: "tsig-1" },
        { type: "text", text: "Hello", textSignature: "sig-1" },
      ],
      api: "scripted-api",
      provider: "scripted",
      model: "scripted-1",
      responseModel: "scripted-1-v2",
      responseId: "resp-1",
      usage: usage(),
      stopReason: "stop",
      timestamp: 1111,
    },
  });
});

// inference.md respondEvent: `toolcall_start` carries `id` and `toolName` —
// lifted from the partial's block at contentIndex (pi's own proxy translation)
test("respond: toolcall_start lifts id and toolName from the partial's block", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(3, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();

  const toolCall = {
    type: "toolCall" as const,
    id: "call_9",
    name: "get_weather",
    arguments: { city: "Oslo" },
    thoughtSignature: "th-1",
  };
  call.stream.push({ type: "start", partial: msg({ content: [] }) });
  call.stream.push({
    type: "toolcall_start",
    contentIndex: 0,
    partial: msg({ content: [{ type: "toolCall", id: "call_9", name: "get_weather", arguments: {} }] }),
  });
  call.stream.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: '{"city":"Oslo"}',
    partial: msg({ content: [{ type: "toolCall", id: "call_9", name: "get_weather", arguments: {} }] }),
  });
  call.stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: msg({ content: [toolCall] }) });
  call.stream.push({ type: "done", reason: "toolUse", message: msg({ content: [toolCall], stopReason: "toolUse" }) });

  const res = await resP;
  assert.deepEqual(c.events(3), [
    { type: "start" },
    { type: "toolcall_start", contentIndex: 0, id: "call_9", toolName: "get_weather" },
    { type: "toolcall_delta", contentIndex: 0, delta: '{"city":"Oslo"}' },
    { type: "toolcall_end", contentIndex: 0 },
  ]);
  assert.equal(res.result.message.stopReason, "toolUse");
  assert.deepEqual(res.result.message.content, [
    { type: "toolCall", id: "call_9", name: "get_weather", arguments: { city: "Oslo" }, thoughtSignature: "th-1" },
  ]);
});

// --- failure mapping ---------------------------------------------------------

// gateway.md: "terminal failure → wire error response_failed or aborted with
// the partial message as error data. pi-ai streams never throw; this mapping
// is the only failure path."
test("respond: a failed turn maps to code 3 with the stripped partialMessage", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(4, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();

  call.stream.push({ type: "start", partial: msg({ content: [] }) });
  call.stream.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
  call.stream.push({ type: "text_delta", contentIndex: 0, delta: "Par", partial: msg({ content: [{ type: "text", text: "Par" }] }) });
  call.stream.push({
    type: "error",
    reason: "error",
    error: msg({
      content: [{ type: "text", text: "Par" }],
      stopReason: "error",
      errorMessage: "provider exploded",
      usage: usage({ output: 1 }),
    }),
  });

  const res = await resP;
  assert.equal(res.error.code, 3);
  assert.equal(res.error.message, "provider exploded");
  // error.data carries the partial with its own stopReason/errorMessage —
  // "may be pushed back into a context to continue an aborted turn"
  assert.deepEqual(res.error.data, {
    partialMessage: {
      role: "assistant",
      content: [{ type: "text", text: "Par" }],
      api: "scripted-api",
      provider: "scripted",
      model: "scripted-1",
      usage: usage({ output: 1 }),
      stopReason: "error",
      errorMessage: "provider exploded",
      timestamp: 1111,
    },
  });
});

// judgment call (flagged in review): a failure that produced nothing — no
// content, zero usage — omits partialMessage (and thus data) entirely;
// inference.md marks partialMessage optional and omits absent fields.
test("respond: failure with no content and zero usage omits partialMessage", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(5, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();
  call.stream.push({
    type: "error",
    reason: "error",
    error: msg({ content: [], stopReason: "error", errorMessage: "setup failed", usage: zeroUsage() }),
  });
  const res = await resP;
  assert.equal(res.error.code, 3);
  assert.equal(res.error.message, "setup failed");
  assert.equal(res.error.data, undefined);
});

// inference.md errors: code 1 model_not_found on "respond with unknown
// provider/model"
test("respond: unknown provider or model is code 1 model_not_found", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const res1 = await c.request(6, "respond", { model: { provider: "nope", id: "x" }, context: CONTEXT });
  assert.equal(res1.error.code, 1);
  assert.match(res1.error.message, /nope\/x/);
  const res2 = await c.request(7, "respond", { model: { provider: "scripted", id: "missing" }, context: CONTEXT });
  assert.equal(res2.error.code, 1);
  assert.equal(f.calls.length, 0, "no provider call for unknown models");
});

// inference.md errors: code 2 provider_not_configured on "respond without
// resolvable auth" — detected via models.getAuth before streaming
test("respond: unresolvable auth is code 2 provider_not_configured", async (t) => {
  const f = scriptedFixture("unconfigured");
  const c = await connect(t, f);
  const res = await c.request(8, "respond", { model: MODEL_REF, context: CONTEXT });
  assert.equal(res.error.code, 2);
  assert.match(res.error.message, /scripted/);
  assert.equal(f.calls.length, 0, "no provider call without auth");
});

// a getAuth REJECTION is an auth-system failure, not "unconfigured" — still
// code 2, with the failure surfaced in error.message (flagged reading)
test("respond: a rejecting getAuth is code 2 with the failure message", async (t) => {
  const f = scriptedFixture("explodes");
  const c = await connect(t, f);
  const res = await c.request(9, "respond", { model: MODEL_REF, context: CONTEXT });
  assert.equal(res.error.code, 2);
  assert.match(res.error.message, /API key auth failed/);
  assert.equal(f.calls.length, 0);
});

// --- cancel & correlation ------------------------------------------------------

// inference.md cancel: "abort the in-flight respond with that id. The
// canceled request still terminates, with error code aborted." Multiplexing:
// a concurrent respond on the same connection is untouched.
test("cancel: aborts mid-stream with code 4; a concurrent respond is unaffected", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);

  const resAP = c.response(10);
  c.send({ jsonrpc: "2.0", id: 10, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const callA = await f.nextCall();
  const resBP = c.response(11);
  c.send({ jsonrpc: "2.0", id: 11, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const callB = await f.nextCall();

  callA.stream.push({ type: "start", partial: msg({ content: [] }) });
  callA.stream.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
  callA.stream.push({ type: "text_delta", contentIndex: 0, delta: "Hal", partial: msg({ content: [{ type: "text", text: "Hal" }] }) });
  callB.stream.push({ type: "start", partial: msg({ content: [] }) });

  // wait until A's deltas reached the wire, then cancel A between events
  await c.waitFor((ms) => (c.events(10).length >= 3 ? true : undefined), "A's events");
  c.notify("cancel", { requestId: 10 });

  // gateway.md: "Every model request runs with an abort signal honoring
  // cancel and connection drop"
  await onAbort(callA.options!.signal!);
  assert.equal(callA.options!.signal!.aborted, true);
  assert.equal(callB.options!.signal!.aborted, false, "the other in-flight request is not aborted");

  // the provider reacts to the abort the way pi-ai providers do: an error
  // terminal with reason "aborted"
  callA.stream.push({
    type: "error",
    reason: "aborted",
    error: msg({
      content: [{ type: "text", text: "Hal" }],
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      usage: usage({ output: 1 }),
    }),
  });
  const resA = await resAP;
  assert.equal(resA.error.code, 4);
  assert.equal(resA.error.data.partialMessage.stopReason, "aborted");
  assert.deepEqual(resA.error.data.partialMessage.content, [{ type: "text", text: "Hal" }]);

  // B keeps streaming and completes normally after A's termination
  callB.stream.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
  callB.stream.push({ type: "text_delta", contentIndex: 0, delta: "Bye", partial: msg({ content: [{ type: "text", text: "Bye" }] }) });
  callB.stream.push({ type: "text_end", contentIndex: 0, content: "Bye", partial: msg({ content: [{ type: "text", text: "Bye" }] }) });
  callB.stream.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: "Bye" }] }) });
  const resB = await resBP;
  assert.equal(resB.result.message.content[0].text, "Bye");

  // correlation rule: nothing is emitted for id 10 after its terminating
  // response — B's later events all carry requestId 11
  const errIdx = c.messages.findIndex((m) => m.id === 10 && "error" in m);
  const after = c.messages.slice(errIdx + 1).filter((m) => m.method === "respondEvent");
  assert.ok(after.length > 0, "B streamed after A terminated");
  assert.ok(after.every((m) => m.params.requestId === 11));
});

// inference.md: the gateway "ignores cancel of ids not currently in flight" —
// unknown ids and already-completed ids alike
test("cancel: unknown and completed request ids are silently ignored", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  c.notify("cancel", { requestId: 999 }); // never seen: ignored

  const resP = c.request(12, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();
  finishTurn(call, msg({ content: [{ type: "text", text: "ok" }] }));
  const res = await resP;
  assert.equal(res.result.message.content[0].text, "ok");

  c.notify("cancel", { requestId: 12 }); // completed: ignored
  // the connection is still healthy — a follow-up respond works
  const res2P = c.request(13, "respond", { model: MODEL_REF, context: CONTEXT });
  const call2 = await f.nextCall();
  assert.equal(call2.options!.signal!.aborted, false, "completed-id cancel must not abort a later request");
  finishTurn(call2, msg({ content: [{ type: "text", text: "still ok" }] }));
  const res2 = await res2P;
  assert.equal(res2.result.message.content[0].text, "still ok");
});

// correlation rule: "A caller must not reuse a request id while its
// connection is open" — a duplicate in-flight id is a protocol-level invalid
// request, and the original stays untouched
test("respond: a duplicate in-flight request id is rejected, original unaffected", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  c.send({ jsonrpc: "2.0", id: 14, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const call = await f.nextCall();

  c.send({ jsonrpc: "2.0", id: 14, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const dup = await c.waitFor((ms) => ms.find((m) => m.id === 14 && "error" in m), "duplicate rejection");
  assert.equal(dup.error.code, -32600);
  assert.equal(f.calls.length, 1, "the duplicate never reached the provider");
  assert.equal(call.options!.signal!.aborted, false, "the original was not aborted");

  finishTurn(call, msg({ content: [{ type: "text", text: "survived" }] }));
  const ok = await c.waitFor((ms) => ms.find((m) => m.id === 14 && "result" in m), "original result");
  assert.equal(ok.result.message.content[0].text, "survived");
});

// inference.md: "A dropped connection cancels all requests in flight on it."
test("connection close aborts in-flight responds (provider signal fires)", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  c.send({ jsonrpc: "2.0", id: 15, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const call = await f.nextCall();
  call.stream.push({ type: "start", partial: msg({ content: [] }) });

  c.end(); // drop the connection mid-stream
  await onAbort(call.options!.signal!);
  assert.equal(call.options!.signal!.aborted, true);

  // provider terminates on abort; the gateway's response write is a no-op on
  // the closed socket — nothing to assert but "does not blow up"
  call.stream.push({
    type: "error",
    reason: "aborted",
    error: msg({ content: [], stopReason: "aborted", errorMessage: "Request was aborted", usage: zeroUsage() }),
  });
});

// --- options ------------------------------------------------------------------

// inference.md Options is a closed subset; gateway.md adds "an abort signal
// ... and an explicit retry bound (pi-ai's Anthropic implementation performs
// no retries by default, its documentation notwithstanding)"
test("respond: options subset passes through; gateway adds signal and maxRetries 2", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(16, "respond", {
    model: MODEL_REF,
    context: CONTEXT,
    options: {
      temperature: 0.5,
      maxTokens: 128,
      reasoning: "high",
      cacheRetention: "long",
      sessionId: "sess-1",
      // non-schema options must not smuggle through to pi-ai:
      bogus: true,
      apiKey: "evil-injected-key",
      maxRetries: 99,
      onPayload: "nope",
    },
  });
  const call = await f.nextCall();
  const o = call.options!;
  assert.equal(o.temperature, 0.5);
  assert.equal(o.maxTokens, 128);
  assert.equal(o.reasoning, "high");
  assert.equal(o.cacheRetention, "long");
  assert.equal(o.sessionId, "sess-1");
  assert.ok(o.signal instanceof AbortSignal, "gateway-owned abort signal present");
  assert.equal(o.maxRetries, 2, "explicit retry bound, not the caller's");
  assert.equal((o as any).bogus, undefined);
  assert.equal((o as any).onPayload, undefined);
  // the apiKey reaching the provider is the resolved credential, never a
  // wire-smuggled one (credentials never cross the wire inbound via respond)
  assert.equal(o.apiKey, "resolved-key");
  finishTurn(call, msg({ content: [{ type: "text", text: "ok" }] }));
  await resP;
});

// --- non-schema field stripping ------------------------------------------------

// inference.md: "pi-ai's per-message diagnostics field is deliberately
// excluded: the gateway strips it — and any other non-schema field — from
// everything it sends on the wire."
test("respond: diagnostics and unknown fields never reach the wire", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(17, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();

  const diagnostics = [{ type: "http", timestamp: 1, error: { message: "boom leak-me" } }];
  const seeded = (over: Partial<AssistantMessage>) => {
    const m = msg(over) as AssistantMessage & { bogusField?: string };
    m.diagnostics = diagnostics;
    m.bogusField = "leak-me";
    return m;
  };
  call.stream.push({ type: "start", partial: seeded({ content: [] }) });
  call.stream.push({ type: "text_start", contentIndex: 0, partial: seeded({ content: [{ type: "text", text: "" }] }) });
  call.stream.push({ type: "text_end", contentIndex: 0, content: "", partial: seeded({ content: [{ type: "text", text: "", textSignature: "s" }] }) });
  call.stream.push({ type: "done", reason: "stop", message: seeded({ content: [{ type: "text", text: "clean" }] }) });
  const res = await resP;
  assert.equal(res.result.message.content[0].text, "clean");

  const turnLines = c.raw.filter((l) => l.includes('"respondEvent"') || l.includes('"id":17'));
  assert.ok(turnLines.length >= 4);
  for (const line of turnLines) {
    assert.ok(!line.includes("diagnostics"), `diagnostics leaked: ${line}`);
    assert.ok(!line.includes("bogusField"), `non-schema field leaked: ${line}`);
    assert.ok(!line.includes("leak-me"), `non-schema value leaked: ${line}`);
    assert.ok(!line.includes("partial"), `pi-ai partial snapshot leaked: ${line}`);
  }
});

// --- failed-turn logging --------------------------------------------------------

// gateway.md: "Failed turns are logged to stderr — error message and
// diagnostics — with request bodies never logged and known secret patterns
// redacted."
test("respond: failed turns log one redacted line, never the request body", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(18, "respond", {
    model: MODEL_REF,
    context: { messages: [{ role: "user", content: "TOPSECRET-CONTEXT-BODY", timestamp: 1 }] },
  });
  const call = await f.nextCall();
  const failure = msg({ content: [], stopReason: "error", errorMessage: "401: key sk-abcdefgh1234 rejected", usage: zeroUsage() }) as AssistantMessage;
  failure.diagnostics = [{ type: "http_error", timestamp: 5, error: { message: "status 401 for sk-abcdefgh1234" } }];
  call.stream.push({ type: "error", reason: "error", error: failure });
  const res = await resP;
  assert.equal(res.error.code, 3);

  assert.equal(f.logLines.length, 1, "exactly one line per failed turn");
  const line = f.logLines[0];
  assert.match(line, /respond/); // the method
  assert.match(line, /scripted\/scripted-1/); // provider/model
  assert.match(line, /401/); // the error message survives
  assert.match(line, /http_error/); // diagnostics summary present
  assert.ok(!line.includes("sk-abcdefgh1234"), "secret redacted");
  assert.match(line, /\[redacted\]/);
  assert.ok(!line.includes("TOPSECRET-CONTEXT-BODY"), "request body never logged");

  // the same secret must not ride the wire error message either
  assert.ok(!res.error.message.includes("sk-abcdefgh1234"), "secret redacted from wire error message");
  assert.match(res.error.message, /\[redacted\]/);
});

// gateway.md ^t-gateway-redact: "the single logged line AND the wire error are
// redacted." A provider error can echo a credential, and stripAssistantMessage
// copies errorMessage verbatim into partialMessage — so redaction must reach
// BOTH the RpcError message and error.data.partialMessage.errorMessage, not just
// the log. Slice C carry-over: stored-credential values are secrets absent from
// env and unmatched by the sk- pattern (gho_, ya29., OAuth access tokens), so
// the stored-secret set proves redaction beyond the pattern.
test("respond: a failed turn redacts secrets from the log AND both wire error fields", async (t) => {
  const f = scriptedFixture();
  f.extraSecrets.push("gho_storedcredtoken99"); // non sk- stored token
  const c = await connect(t, f);
  const resP = c.request(30, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();
  // partial content + non-zero usage → partialMessage rides the wire error, so
  // its errorMessage is a redaction target too
  call.stream.push({
    type: "error",
    reason: "error",
    error: msg({
      content: [{ type: "text", text: "partial before failure" }],
      stopReason: "error",
      errorMessage: "401 for token gho_storedcredtoken99 and key sk-abcdefgh1234",
      usage: usage(),
    }),
  });
  const res = await resP;
  assert.equal(res.error.code, 3);

  // the log
  assert.equal(f.logLines.length, 1);
  assert.ok(!f.logLines[0].includes("gho_storedcredtoken99"), "stored token redacted from the log");
  assert.ok(!f.logLines[0].includes("sk-abcdefgh1234"), "sk- key redacted from the log");
  assert.match(f.logLines[0], /\[redacted\]/);

  // the wire error message (the RpcError message)
  assert.ok(!res.error.message.includes("gho_storedcredtoken99"), "stored token redacted from wire error message");
  assert.ok(!res.error.message.includes("sk-abcdefgh1234"), "sk- key redacted from wire error message");
  assert.match(res.error.message, /\[redacted\]/);

  // the partialMessage's errorMessage carried in error.data
  const pm = res.error.data.partialMessage;
  assert.ok(pm !== undefined, "partialMessage present");
  assert.ok(!pm.errorMessage.includes("gho_storedcredtoken99"), "stored token redacted from partialMessage.errorMessage");
  assert.ok(!pm.errorMessage.includes("sk-abcdefgh1234"), "sk- key redacted from partialMessage.errorMessage");
  assert.match(pm.errorMessage, /\[redacted\]/);
});

// a successful turn logs nothing
test("respond: successful turns are not logged", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(19, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();
  finishTurn(call, msg({ content: [{ type: "text", text: "fine" }] }));
  await resP;
  assert.deepEqual(f.logLines, []);
});

// --- params validation -----------------------------------------------------------

test("respond: malformed params are invalid params (-32602)", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const noModel = await c.request(20, "respond", { context: CONTEXT });
  assert.equal(noModel.error.code, -32602);
  const noContext = await c.request(21, "respond", { model: MODEL_REF });
  assert.equal(noContext.error.code, -32602);
  assert.equal(f.calls.length, 0);
});

// inference.md: content is (Text|Thinking|ToolCall)[] — a block type outside
// the union (buggy/custom provider) must be dropped, never serialized as
// null or leaked (review finding: unguarded switch produced null)
test("respond: unknown content-block type is dropped from wire messages", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const call = await f.nextCall();
  const weird = { type: "weird_new_block", stuff: "x" } as any;
  const final = msg({ content: [{ type: "text", text: "ok" }, weird] });
  call.stream.push({ type: "done", reason: "stop", message: final });
  const res = await resP;
  assert.deepEqual(res.result.message.content, [{ type: "text", text: "ok" }]);
  assert.ok(!JSON.stringify(res).includes("null,"), "no null holes on the wire");
  assert.ok(!JSON.stringify(res).includes("weird_new_block"));
});

// inference.md correlation rule: "a caller must not reuse a request id while
// its connection is open" — enforced even when the duplicate is PIPELINED in
// the same chunk (registration is synchronous, before any await)
test("respond: pipelined duplicate id in one chunk is rejected without touching the original", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const line = (id: number) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "respond", params: { model: MODEL_REF, context: CONTEXT } }) + "\n";
  // the duplicate error and the original's eventual result both bear id 2, so
  // match by occurrence: the first id-2 response is the rejection
  const dupP = c.waitFor((ms) => ms.filter((m) => m.id === 2 && ("result" in m || "error" in m))[0], "dup response");
  c.socket.write(line(2) + line(2));
  const dup = await dupP;
  assert.equal(dup.error.code, -32600);
  // the original request is still live: provider called exactly once, and it completes normally
  const call = await f.nextCall();
  assert.equal(f.calls.length, 1);
  const resP = c.waitFor((ms) => ms.filter((m) => m.id === 2 && ("result" in m || "error" in m))[1], "second id-2 response");
  call.stream.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: "ok" }] }) });
  const res = await resP;
  assert.equal(res.result.message.content[0].text, "ok");
});

// cancel of a malformed requestId (or junk params) is silently ignored, like
// any unknown id — never an error, never a crash
test("cancel: malformed params are silently ignored", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  c.notify("cancel", { requestId: { nested: true } });
  c.notify("cancel", {});
  c.notify("cancel", null);
  // connection still fully functional afterwards
  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const call = await f.nextCall();
  call.stream.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: "ok" }] }) });
  const res = await resP;
  assert.equal(res.result.message.content[0].text, "ok");
});

// options of a non-object type is treated as absent, not an error and not
// something that reaches pi-ai
test("respond: non-object options treated as absent", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "respond", params: { model: MODEL_REF, context: CONTEXT, options: "hot" } });
  const call = await f.nextCall();
  assert.equal(call.options?.temperature, undefined);
  assert.equal(call.options?.maxRetries, 2, "gateway-owned options still applied");
  call.stream.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: "ok" }] }) });
  const res = await resP;
  assert.equal(res.result.message.content[0].text, "ok");
});

// inference.md model reference is {provider: string, id: string}; a wrong-typed
// provider or id is invalid params (-32602), and nothing reaches the provider
test("respond: wrong-typed model.provider or model.id is invalid params (-32602)", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const badProvider = await c.request(40, "respond", { model: { provider: 123, id: "x" }, context: CONTEXT });
  assert.equal(badProvider.error.code, -32602);
  const badId = await c.request(41, "respond", { model: { provider: "scripted", id: 456 }, context: CONTEXT });
  assert.equal(badId.error.code, -32602);
  const nullModel = await c.request(42, "respond", { model: null, context: CONTEXT });
  assert.equal(nullModel.error.code, -32602);
  assert.equal(f.calls.length, 0, "no provider call for a malformed model reference");
});

// inference.md correlation uses "the caller's respond request id"; JSON-RPC ids
// may be strings. A string-id respond streams events correlated by that string
// and terminates with the string-id response — not only numeric ids work.
test("respond: a string request id works end to end", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  c.send({ jsonrpc: "2.0", id: "req-abc", method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const call = await f.nextCall();
  call.stream.push({ type: "start", partial: msg({ content: [] }) });
  call.stream.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
  call.stream.push({ type: "text_delta", contentIndex: 0, delta: "hey", partial: msg({ content: [{ type: "text", text: "hey" }] }) });
  call.stream.push({ type: "text_end", contentIndex: 0, content: "hey", partial: msg({ content: [{ type: "text", text: "hey" }] }) });
  call.stream.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: "hey" }] }) });

  // respondEvents are correlated by the string request id
  const events = await c.waitFor(
    (ms) => {
      const evs = ms.filter((m) => m.method === "respondEvent" && m.params?.requestId === "req-abc").map((m) => m.params.event);
      return evs.some((e) => e.type === "text_end") ? evs : undefined;
    },
    "string-id events",
  );
  assert.deepEqual(events, [
    { type: "start" },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "hey" },
    { type: "text_end", contentIndex: 0 },
  ]);
  const res = await c.waitFor((ms) => ms.find((m) => m.id === "req-abc" && "result" in m), "string-id response");
  assert.equal(res.result.message.content[0].text, "hey");
});

// inference.md cancel: "The canceled request still terminates, with error code
// aborted." Canceled before any content is produced → code 4, and with nothing
// produced (no content, zero usage) the optional partialMessage is omitted.
test("respond: canceled before any content is code 4 with no partial", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.response(43);
  c.send({ jsonrpc: "2.0", id: 43, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const call = await f.nextCall();

  // cancel before any event is emitted
  c.notify("cancel", { requestId: 43 });
  await onAbort(call.options!.signal!);
  assert.equal(call.options!.signal!.aborted, true);

  // provider reacts to the abort with an aborted terminal that produced nothing
  call.stream.push({
    type: "error",
    reason: "aborted",
    error: msg({ content: [], stopReason: "aborted", errorMessage: "Request was aborted", usage: zeroUsage() }),
  });
  const res = await resP;
  assert.equal(res.error.code, 4);
  assert.equal(res.error.data, undefined, "nothing produced → no partialMessage");
  assert.deepEqual(c.events(43), [], "no content events reached the wire");
});

// gateway.md: "The gateway never acts on a tool call; it is data in the
// response, and acting on it is the caller's business." A toolUse turn returns
// the tool call verbatim and triggers no follow-up provider call.
test("respond: a tool call is returned as data and triggers no gateway-side action", async (t) => {
  const f = scriptedFixture();
  const c = await connect(t, f);
  const resP = c.request(44, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();
  const toolCall = { type: "toolCall" as const, id: "call_1", name: "run", arguments: { x: 1 } };
  call.stream.push({ type: "start", partial: msg({ content: [] }) });
  call.stream.push({ type: "done", reason: "toolUse", message: msg({ content: [toolCall], stopReason: "toolUse" }) });
  const res = await resP;

  assert.equal(res.result.message.stopReason, "toolUse");
  assert.deepEqual(res.result.message.content, [{ type: "toolCall", id: "call_1", name: "run", arguments: { x: 1 } }]);
  // the gateway did not act on the tool call: no second provider call, no
  // further wire traffic for the (now terminated) request
  assert.equal(f.calls.length, 1, "exactly one provider call — the gateway does not execute tools");
  const afterResult = c.messages.filter((m) => m.method === "respondEvent" && m.params?.requestId === 44 && m.params.event.type !== "start");
  assert.deepEqual(afterResult, [], "no tool-driven follow-up events");
});

// binding guard (gateway.md): "Credentials never leave the gateway outbound."
// The resolved api key that reaches the provider must appear nowhere in a
// successful respond's events or result on the wire.
test("respond: the resolved credential never appears on the wire", async (t) => {
  const f = scriptedFixture(); // resolve() returns apiKey "resolved-key"
  const c = await connect(t, f);
  const resP = c.request(45, "respond", { model: MODEL_REF, context: CONTEXT });
  const call = await f.nextCall();
  assert.equal(call.options!.apiKey, "resolved-key", "the provider did receive the resolved key");
  finishTurn(call, msg({ content: [{ type: "text", text: "done" }] }));
  await resP;
  for (const line of c.raw) {
    assert.ok(!line.includes("resolved-key"), `resolved credential leaked to the wire: ${line}`);
  }
});
