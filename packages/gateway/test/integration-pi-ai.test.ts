import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createModels, createProvider, type Api, type Model } from "@earendil-works/pi-ai";
// The stock openai-completions provider path, imported from pi-ai's real
// (non-/compat) api subpath. This is what a registered OpenAI-compatible
// custom provider dispatches through.
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { makeRespondHandlers } from "../src/wire/respond.ts";
import { FileCredentialStore } from "../src/storage/credentials.ts";
import { Client, connectClient, initHandler, startWireServer, tmpDir } from "./helpers.ts";

// --- why this file -----------------------------------------------------------
// Every scripted `respond` test injects a hand-rolled ProviderStreams, so those
// suites would still pass if the REAL pi-ai boundary broke: Models.streamSimple
// dispatch, option/credential plumbing, or terminal mapping against pinned
// pi-ai 0.80.6. This one test crosses that boundary for real — no network, no
// credentials — by standing up a local OpenAI-compatible chat-completions SSE
// server that the stock `openai-completions` api actually talks to (real OpenAI
// SDK, real HTTP, real SSE parsing), driven through the gateway's real handler
// over the real Unix socket. The scripted suites keep exhaustive event-
// translation coverage; this proves the wrapping itself is wired to pi-ai.

// --- a local OpenAI-compatible chat-completions server (SSE) ------------------

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** One streamed chat-completion chunk in OpenAI's wire shape. */
type Chunk = Record<string, unknown>;

interface LocalProvider {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Number of HTTP requests the server has received (retries included). */
  hits: () => number;
  /** Install the responder the server runs for each request. */
  onRequest: (fn: (req: CapturedRequest, res: http.ServerResponse) => void) => void;
}

/** A node:http server speaking just enough of the OpenAI streaming
 * chat-completions API for pi-ai's openai-completions provider to consume.
 * Deterministic: the responder controls every byte and its timing. */
async function startLocalProvider(t: TestContext): Promise<LocalProvider> {
  const requests: CapturedRequest[] = [];
  let responder: (req: CapturedRequest, res: http.ServerResponse) => void = (_req, res) => res.end();

  const server = http.createServer((httpReq, res) => {
    let raw = "";
    httpReq.on("data", (c) => (raw += c));
    httpReq.on("end", () => {
      const captured: CapturedRequest = {
        url: httpReq.url ?? "",
        authorization: httpReq.headers.authorization,
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(captured);
      // a client abort tears down the socket mid-response; never surface that
      // as an unhandled 'error' on the held response
      res.on("error", () => {});
      responder(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    hits: () => requests.length,
    onRequest: (fn) => {
      responder = fn;
    },
  };
}

/** Write one SSE `data:` frame carrying an OpenAI chat-completion chunk. */
function sse(res: http.ServerResponse, chunk: Chunk): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

// --- real Models over the local provider -------------------------------------

const RESOLVED_KEY = "resolved-integration-key-abcdef123456";
const CONTEXT_MARKER = "integration probe: the quick brown fox";

/** A real `Models` with one registered custom provider whose api is the stock
 * openai-completions implementation, pointed at the local server. Auth is the
 * stock env-or-stored resolution over a real FileCredentialStore seeded with a
 * distinctive api-key credential — so the credential the server sees is the one
 * the gateway actually resolved. */
async function realFixture(t: TestContext, baseUrl: string) {
  const store = new FileCredentialStore(tmpDir(t, "pino-integration-state-"));
  // seed a stored credential — the resolved value must reach the provider as
  // the bearer token
  await store.modify("local", async () => ({ type: "api_key", key: RESOLVED_KEY }));

  const model: Model<Api> = {
    id: "local-model-1",
    name: "Local Model",
    api: "openai-completions",
    provider: "local",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };

  const models = createModels({ credentials: store });
  models.setProvider(
    createProvider({
      id: "local",
      name: "Local",
      // stock stored-credential-wins resolution; no env needed
      auth: {
        apiKey: {
          name: "Local key",
          resolve: async ({ credential }) =>
            credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );

  const logLines: string[] = [];
  const { respond, cancel } = makeRespondHandlers(models, (l) => logLines.push(l), () => store.secretValues());
  const sockPath = await startWireServer(t, { initialize: initHandler(), respond, cancel });
  const c = await connectClient(t, sockPath);
  return { c, logLines, store, model };
}

const MODEL_REF = { provider: "local", id: "local-model-1" };
const CONTEXT = { messages: [{ role: "user", content: CONTEXT_MARKER, timestamp: 1 }] };

// --- case 1: a real successful turn ------------------------------------------

// The whole crossing on the happy path: the resolved credential reaches the
// provider, the context is mapped to the provider's request, real pi-ai stream
// events reduce to the exact inference respondEvent wire shapes, and the real
// terminal becomes the `respond` result. gateway.md V0: "Stream outcomes map
// exactly: terminal success → the respond result."
test("integration: a real openai-completions turn — credential, context, events, result", async (t) => {
  const local = await startLocalProvider(t);
  local.onRequest((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { id: "chatcmpl-1", model: "srv-model-x", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] });
    sse(res, { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] });
    sse(res, { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    sse(res, { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const { c } = await realFixture(t, local.baseUrl);

  const res = await c.request(2, "respond", { model: MODEL_REF, context: CONTEXT });

  // the resolved credential reached the provider as the bearer token — and it
  // was resolved by the gateway (real FileCredentialStore + Models auth), not
  // smuggled over the wire
  assert.equal(local.requests.length, 1);
  assert.equal(local.requests[0].url, "/chat/completions");
  assert.equal(local.requests[0].authorization, `Bearer ${RESOLVED_KEY}`);

  // the context was mapped into the provider's request messages
  const sent = local.requests[0].body.messages as { role: string; content: unknown }[];
  assert.ok(sent.some((m) => m.role === "user" && m.content === CONTEXT_MARKER), "user context reached the provider");

  // real pi-ai stream events became EXACTLY the inference respondEvent wire
  // shapes (bandwidth-stripped: no partial snapshots, no terminal types).
  // openai-completions emits no text signature, so text_end carries none.
  assert.deepEqual(c.events(2), [
    { type: "start" },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "Hel" },
    { type: "text_delta", contentIndex: 0, delta: "lo" },
    { type: "text_end", contentIndex: 0 },
  ]);

  // the real terminal mapped to the respond result
  const msg = res.result.message;
  assert.deepEqual(msg.content, [{ type: "text", text: "Hello" }]);
  assert.equal(msg.stopReason, "stop");
  assert.equal(msg.api, "openai-completions");
  assert.equal(msg.provider, "local");
  assert.equal(msg.model, "local-model-1");
  assert.equal(msg.usage.input, 11);
  assert.equal(msg.usage.output, 4);
  assert.equal(msg.usage.totalTokens, 15);

  // binding guard (gateway.md): credentials never cross the wire outbound —
  // the resolved key appears in no event and in no result on the socket
  const wireForTurn = c.raw.filter((l) => l.includes('"respondEvent"') || l.includes('"id":2'));
  for (const line of wireForTurn) {
    assert.ok(!line.includes(RESOLVED_KEY), `resolved credential leaked to the wire: ${line}`);
  }
});

// --- case 2: aborting a real in-flight request -------------------------------

// gateway.md V0: "terminal failure → aborted"; the abort signal honors
// `cancel`. Here the abort crosses the real boundary: `cancel` aborts the
// gateway's per-request signal, pi-ai passes it to the OpenAI SDK's fetch, the
// in-flight HTTP read is torn down, and pi-ai's terminal comes back
// stopReason "aborted" → wire code 4.
test("integration: canceling a real in-flight request ends in error code 4", async (t) => {
  const local = await startLocalProvider(t);
  const held: http.ServerResponse[] = [];
  local.onRequest((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // one delta, then hold the stream open (never [DONE]) so the cancel lands
    // on a genuinely in-flight request
    sse(res, { id: "chatcmpl-2", choices: [{ index: 0, delta: { role: "assistant", content: "Par" }, finish_reason: null }] });
    held.push(res);
  });
  t.after(() => {
    for (const res of held) {
      try {
        res.end();
      } catch {
        /* already torn down by the abort */
      }
    }
  });
  const { c } = await realFixture(t, local.baseUrl);

  const resP = c.response(3);
  c.send({ jsonrpc: "2.0", id: 3, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });

  // wait until the first real delta reached the wire, then cancel
  await c.waitFor((ms) => (c.events(3).length >= 2 ? true : undefined), "first real delta");
  c.notify("cancel", { requestId: 3 });

  const res = await resP;
  assert.equal(res.error.code, 4, "aborted");
  // the partial produced before the abort came back through the real terminal
  assert.equal(res.error.data.partialMessage.stopReason, "aborted");
  assert.deepEqual(res.error.data.partialMessage.content, [{ type: "text", text: "Par" }]);
});

// --- case 3: the explicit retry bound reaches the real SDK -------------------

// gateway.md V0: "an explicit retry bound (pi-ai's Anthropic implementation
// performs no retries by default)". The scripted suite asserts maxRetries===2
// at the options object; this proves the bound actually reaches the real SDK's
// retry loop. The server marks each 500 retryable with a ~0ms backoff, so the
// SDK retries deterministically and fast: exactly 1 initial + 2 retries.
test("integration: the explicit retry bound (2) reaches the real SDK", async (t) => {
  const local = await startLocalProvider(t);
  local.onRequest((_req, res) => {
    res.writeHead(500, { "content-type": "application/json", "x-should-retry": "true", "retry-after-ms": "1" });
    res.end(JSON.stringify({ error: { message: "transient upstream error" } }));
  });
  const { c } = await realFixture(t, local.baseUrl);

  const res = await c.request(4, "respond", { model: MODEL_REF, context: CONTEXT });
  assert.equal(res.error.code, 3, "response_failed after the bounded retries are exhausted");
  assert.equal(local.hits(), 3, "1 initial attempt + exactly 2 retries — the gateway's explicit bound");
});
