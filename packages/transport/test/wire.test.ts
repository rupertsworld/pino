import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { RpcError, type MethodHandler } from "../src/server.ts";
import { Client, initHandler, initParams, startWireServer, withTimeout, type HandshakeFixture } from "./helpers.ts";

// transport.md handshake is schema-agnostic. Transport's OWN tests deliberately
// speak a NEUTRAL schema (not pino.inference) to prove the wire's handshake is
// not inference-specific — the inference defaults live only in the shared
// helper's defaults, for gateway's benefit.
const TEST_HANDSHAKE: HandshakeFixture = {
  schema: "test.echo",
  versions: [1],
  serverInfo: { name: "test-echo-server", version: "0.0.0-test" },
};

/** initialize params for the neutral test schema, with optional overrides. */
function params(overrides: Record<string, unknown> = {}) {
  return initParams(overrides, TEST_HANDSHAKE);
}

/** A wire server carrying the neutral-schema initialize handler plus any extras. */
function startServer(t: TestContext, extraHandlers: Record<string, MethodHandler> = {}): Promise<string> {
  return startWireServer(t, { initialize: initHandler(TEST_HANDSHAKE), ...extraHandlers });
}

test("initialize happy path returns version and serverInfo", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  const res = await c.next();
  // transport.md handshake: "The listener accepts by echoing the version"
  assert.deepEqual(res, {
    jsonrpc: "2.0",
    id: 1,
    result: { version: 1, serverInfo: TEST_HANDSHAKE.serverInfo },
  });
});

// transport.md compatibility: "Unknown fields are ignored — never an error."
test("initialize with unknown fields still succeeds", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params({ future: true }), extra: 1 });
  const res = await c.next();
  assert.equal(res.result.version, 1);
});

// transport.md handshake: "refuses with an error naming the versions it supports"
test("initialize with unsupported version is refused with supported list", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params({ version: 2 }) });
  const res = await c.next();
  // transport.md handshake mandates -32602 invalid params with data.supported;
  // deep-assert the envelope (message is human-readable/non-contractual).
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 1);
  assert.equal(res.error.code, -32602);
  assert.deepEqual(res.error.data, { supported: [1] });
  // connection is still un-initialized: retry with a supported version works
  // (transport.md: "the dialer may retry with one of those")
  c.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: params() });
  const retry = await c.next();
  assert.equal(retry.result.version, 1);
});

test("initialize with wrong schema is refused with supported list", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params({ schema: "wrong.schema" }) });
  const res = await c.next();
  // transport.md mandates -32602 for a schema the listener does not speak.
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 1);
  assert.equal(res.error.code, -32602);
  assert.deepEqual(res.error.data, { supported: [1] });
});

// transport.md handshake: "initialize happens exactly once per connection;
// a repeat is rejected with a protocol error."
test("repeat initialize is rejected, connection stays initialized", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: params() });
  const res = await c.next();
  assert.equal(res.id, 2);
  assert.ok(res.error, "expected an error");
  // transport.md handshake: "a repeat is rejected with -32003 already initialized"
  assert.equal(res.error.code, -32003);
  // still usable after the rejected repeat
  c.send({ jsonrpc: "2.0", id: 3, method: "nosuch" });
  const after = await c.next();
  assert.equal(after.error.code, -32601);
});

// transport.md handshake: "initialize happens exactly once per connection" —
// two initialize requests pipelined into one TCP chunk must not both succeed.
test("two initialize requests in one write: second is rejected with -32003", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  const line1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() }) + "\n";
  const line2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: params() }) + "\n";
  c.socket.write(line1 + line2); // single write — arrives as one chunk
  const responses = [await c.next(), await c.next()];
  const first = responses.find((r) => r.id === 1);
  const second = responses.find((r) => r.id === 2);
  assert.equal(first.result.version, 1);
  assert.ok(second.error, "expected the pipelined repeat to be rejected");
  assert.equal(second.error.code, -32003);
});

// transport.md handshake: "Until initialize resolves, nothing else is allowed
// on the connection: other requests are answered with an error"
test("request before initialize gets -32002 not initialized", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "listModels" });
  const res = await c.next();
  assert.equal(res.id, 1);
  assert.equal(res.error.code, -32002);
});

// transport.md handshake: "... notifications are ignored."
test("notification before initialize is ignored, connection survives", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", method: "something", params: {} });
  await c.expectSilence();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  const res = await c.next();
  assert.equal(res.result.version, 1);
});

// transport.md compatibility: "Unknown methods get method not found"
test("unknown request method after initialize gets -32601", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "definitelyNotAMethod" });
  const res = await c.next();
  assert.equal(res.id, 2);
  assert.equal(res.error.code, -32601);
});

// transport.md envelope: "A notification ... is never replied to, not even
// with an error"; compatibility: unknown notifications "are silently dropped".
test("unknown notification after initialize is never answered", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", method: "definitelyNotAMethod", params: {} });
  // a follow-up request gets the next response — nothing for the notification
  c.send({ jsonrpc: "2.0", id: 2, method: "alsoUnknown" });
  const res = await c.next();
  assert.equal(res.id, 2);
  await c.expectSilence();
});

// JSON-RPC 2.0 spec: parse error -32700, id null.
test("malformed JSON gets -32700 with id null", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.socket.write("this is not json\n");
  const res = await c.next();
  assert.equal(res.id, null);
  assert.equal(res.error.code, -32700);
});

// transport.md envelope: "JSON-RPC's batch form (an array of messages) is
// excluded — the framing rule of one object per line already forbids it"
test("a batch array is rejected", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send([{ jsonrpc: "2.0", id: 1, method: "initialize", params: params() }]);
  const res = await c.next();
  assert.equal(res.id, null);
  assert.equal(res.error.code, -32600);
});

test("a non-object non-array message is rejected", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send("just a string");
  const res = await c.next();
  assert.equal(res.error.code, -32600);
});

// transport.md framing: "reads may slice messages anywhere"
test("messages split and joined across write boundaries are framed correctly", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  const line1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() }) + "\n";
  const line2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nosuch" }) + "\n";
  const bytes = Buffer.from(line1 + line2);
  // dribble the two messages out in awkward slices
  for (let i = 0; i < bytes.length; i += 7) {
    c.socket.write(bytes.subarray(i, Math.min(i + 7, bytes.length)));
    await new Promise((r) => setImmediate(r));
  }
  const res1 = await c.next();
  assert.equal(res1.result.version, 1);
  const res2 = await c.next();
  assert.equal(res2.error.code, -32601);
});

// transport.md framing: "closing the connection when a line exceeds it"
test("a line exceeding 16 MiB closes the connection", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  const big = Buffer.alloc(16 * 1024 * 1024 + 16, 0x61); // no newline anywhere
  c.socket.write(big);
  // timeout so a regression fails the test instead of hanging it
  await Promise.race([
    c.closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for the server to close the connection")), 5000).unref(),
    ),
  ]);
});

// transport.md direction: "a listening component may put a request to the
// peer that dialed it"; ids are scoped per direction.
test("server can send its own request to the client and match the response", async (t) => {
  const asked: unknown[] = [];
  const sockPath = await startServer(t, {
    ask: async (_params, conn) => {
      const answer = await conn.request("clientQuestion", { q: "ok?" });
      asked.push(answer);
      return { relayed: answer };
    },
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  // client uses id 2; the server's outbound id space is independent of it
  c.send({ jsonrpc: "2.0", id: 2, method: "ask", params: {} });
  const serverReq = await c.next();
  assert.equal(serverReq.method, "clientQuestion");
  assert.ok(serverReq.id !== undefined && serverReq.id !== null);
  c.send({ jsonrpc: "2.0", id: serverReq.id, result: { value: "yes" } });
  const res = await c.next();
  assert.equal(res.id, 2);
  assert.deepEqual(res.result, { relayed: { value: "yes" } });
  assert.deepEqual(asked, [{ value: "yes" }]);
});

// transport.md direction: "each side matches responses against its own
// outbound ids only; the two sides' id spaces never interact"
test("a client response reusing the client's own request id does not collide", async (t) => {
  const sockPath = await startServer(t, {
    ask: async (_params, conn) => conn.request("clientQuestion", {}),
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  // client mints id 1 for initialize — the same number the server will
  // likely mint first for its outbound request
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 1729, method: "ask", params: {} });
  const serverReq = await c.next();
  c.send({ jsonrpc: "2.0", id: serverReq.id, result: "answered" });
  const res = await c.next();
  assert.equal(res.id, 1729);
  assert.equal(res.result, "answered");
});

// transport.md: the server owns the inbound-request lifecycle and enforces the
// no-reuse rule CENTRALLY, across ALL methods — a request whose id is already
// in flight is rejected regardless of which method it names. This closes the
// gap a per-handler registry left: an id in flight under one method could be
// reused by another. inference.md correlation rule ("A caller must not reuse a
// request id while its connection is open") makes the gate cover the
// connection's LIFETIME: even after the first request-42 completes, id 42 stays
// spent for as long as the connection is open.
test("an id reused on a connection is rejected — in flight and after completion", async (t) => {
  // `hold` stays in flight until the test releases it; `quick` returns at once.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const sockPath = await startServer(t, {
    hold: async () => {
      await held;
      return { held: true };
    },
    quick: () => ({ quick: true }),
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();

  // id 42 goes in flight under `hold`
  c.send({ jsonrpc: "2.0", id: 42, method: "hold" });
  // reuse id 42 under a DIFFERENT method while the first is still in flight —
  // the rejection and the eventual hold result both bear id 42, so match by
  // result-vs-error rather than by id alone
  const dupP = c.waitFor((ms) => ms.find((m) => m.id === 42 && "error" in m), "dup rejection");
  c.send({ jsonrpc: "2.0", id: 42, method: "quick" });
  const dup = await dupP;
  assert.equal(dup.error.code, -32600, "cross-method id reuse is invalid request");

  // the original `hold` is untouched: release it and it completes normally
  release();
  const held2 = await c.waitFor((ms) => ms.find((m) => m.id === 42 && "result" in m), "hold result");
  assert.deepEqual(held2.result, { held: true });

  // inference.md lifetime rule: even AFTER the first request-42 completed, id 42
  // stays spent for the life of the connection — reusing it is still rejected
  // with -32600 and the `quick` handler is never invoked. (Were it to free up,
  // a late `cancel{42}` for the old request could abort this new one.)
  const rejectP = c.waitFor(
    (ms) => ms.filter((m) => m.id === 42 && "error" in m)[1],
    "second id-42 rejection",
  );
  c.send({ jsonrpc: "2.0", id: 42, method: "quick" });
  const rejected = await rejectP;
  assert.equal(rejected.error.code, -32600, "a completed id cannot be reused for the connection's lifetime");
  // no second id-42 result was produced: `quick` never ran under the reused id
  assert.equal(
    c.messages.filter((m) => m.id === 42 && "result" in m).length,
    1,
    "the reused id produced no new result — the handler was not invoked",
  );

  // the connection is still healthy: a FRESH id works
  const okP = c.waitFor((ms) => ms.find((m) => m.id === 43 && "result" in m), "fresh id result");
  c.send({ jsonrpc: "2.0", id: 43, method: "quick" });
  assert.deepEqual((await okP).result, { quick: true });
});

// a stray response to an id we never sent is dropped, not answered
test("an unmatched response from the client is silently dropped", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 999, result: {} });
  await c.expectSilence();
});

// a non-RpcError handler failure answers -32603 and logs the underlying
// error (message + stack) to stderr so it is diagnosable
test("a handler throwing a plain Error gets -32603 and is logged to stderr", async (t) => {
  const sockPath = await startServer(t, {
    explode: () => {
      throw new Error("kaboom from handler");
    },
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  // the server runs in-process, so capture our own stderr around the request
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    c.send({ jsonrpc: "2.0", id: 2, method: "explode" });
    const res = await c.next();
    assert.equal(res.error.code, -32603);
  } finally {
    process.stderr.write = original;
  }
  assert.match(captured, /kaboom from handler/, "stderr names the underlying error");
  assert.match(captured, /at /, "stderr includes a stack trace");
});

// --- envelope & compatibility ------------------------------------------------

// transport.md envelope: "Senders always include the `jsonrpc:2.0` tag;
// receivers tolerate its absence" — a request missing the tag still succeeds,
// on initialize AND on an ordinary method.
test("a request without the jsonrpc tag still succeeds (receiver leniency)", async (t) => {
  const sockPath = await startServer(t, { echo: (p) => p });
  const c = new Client(sockPath);
  t.after(() => c.end());
  // initialize with no jsonrpc field
  c.send({ id: 1, method: "initialize", params: params() });
  const init = await c.next();
  assert.equal(init.result.version, 1);
  // an ordinary post-initialize method, also missing the tag
  c.send({ id: 2, method: "echo", params: { ping: true } });
  const res = await c.next();
  assert.equal(res.id, 2);
  assert.deepEqual(res.result, { ping: true });
});

// transport.md envelope: "Senders always include the `jsonrpc:2.0` tag." Every
// server-ORIGINATED message — a response, a request it initiates, and a
// notification it emits — carries the tag.
test("server-originated response, request, and notification all carry jsonrpc:2.0", async (t) => {
  const sockPath = await startServer(t, {
    emit: async (_p, conn) => {
      conn.notify("tick", { n: 1 }); // server-originated notification
      const answer = await conn.request("ping", {}); // server-originated request
      return { got: answer };
    },
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "emit" });

  const tick = await c.waitFor((ms) => ms.find((m) => m.method === "tick"), "server notification");
  assert.equal(tick.jsonrpc, "2.0");
  assert.equal(tick.id, undefined, "a notification carries no id");

  const ping = await c.waitFor((ms) => ms.find((m) => m.method === "ping" && "id" in m), "server request");
  assert.equal(ping.jsonrpc, "2.0");
  c.send({ jsonrpc: "2.0", id: ping.id, result: "pong" });

  const res = await c.waitFor((ms) => ms.find((m) => m.id === 2 && "result" in m), "emit response");
  assert.equal(res.jsonrpc, "2.0", "the response envelope carries the tag");
  assert.deepEqual(res.result, { got: "pong" });
});

// transport.md compatibility: "Unknown fields are ignored — never an error."
// This holds for an ORDINARY method, not only initialize.
test("unknown fields are ignored on an ordinary method", async (t) => {
  const sockPath = await startServer(t, { echo: (p) => p ?? {} });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  // extra top-level members AND an extra params member the handler never reads
  c.send({ jsonrpc: "2.0", id: 2, method: "echo", params: { keep: 1, future: true }, sideband: "ignored" });
  const res = await c.next();
  assert.equal(res.id, 2);
  assert.deepEqual(res.result, { keep: 1, future: true });
});

// transport.md envelope: a notification "is never replied to, not even with an
// error." A known notification handler runs exactly once and produces no wire
// response — even when it throws.
test("a known notification handler runs once and is never answered, even when it throws", async (t) => {
  let calls = 0;
  const sockPath = await startServer(t, {
    onEvent: () => {
      calls++;
      throw new Error("a notification outcome is never reported");
    },
    sentinel: () => ({ ok: true }),
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  const before = c.messages.length;
  // fire the notification (no id), then a sentinel request as a protocol
  // barrier: once the sentinel answers, the notification has been dispatched
  c.send({ jsonrpc: "2.0", method: "onEvent", params: {} });
  c.send({ jsonrpc: "2.0", id: 2, method: "sentinel" });
  const res = await c.waitFor((ms) => ms.find((m) => m.id === 2 && "result" in m), "sentinel response");
  assert.deepEqual(res.result, { ok: true });
  assert.equal(calls, 1, "the notification handler ran exactly once");
  // exactly one message arrived after the barrier point: the sentinel response
  assert.equal(c.messages.length - before, 1, "the throwing notification produced no wire response");
});

// transport.md: multiple requests may be in flight on one connection; each is
// owed exactly one response, matched by id, regardless of completion order.
test("simultaneous requests complete out of order, each answered exactly once", async (t) => {
  let releaseA!: () => void;
  let releaseB!: () => void;
  const a = new Promise<void>((r) => (releaseA = r));
  const b = new Promise<void>((r) => (releaseB = r));
  const sockPath = await startServer(t, {
    slowA: async () => {
      await a;
      return { who: "A" };
    },
    slowB: async () => {
      await b;
      return { who: "B" };
    },
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  // both go in flight before either completes
  c.send({ jsonrpc: "2.0", id: 10, method: "slowA" });
  c.send({ jsonrpc: "2.0", id: 11, method: "slowB" });
  // release B first: responses arrive out of submission order (gated, no sleep)
  releaseB();
  const resB = await c.waitFor((ms) => ms.find((m) => m.id === 11 && "result" in m), "B response");
  assert.deepEqual(resB.result, { who: "B" });
  releaseA();
  const resA = await c.waitFor((ms) => ms.find((m) => m.id === 10 && "result" in m), "A response");
  assert.deepEqual(resA.result, { who: "A" });
  // each id got exactly one response
  assert.equal(c.messages.filter((m) => m.id === 10 && "result" in m).length, 1);
  assert.equal(c.messages.filter((m) => m.id === 11 && "result" in m).length, 1);
});

// transport.md: "a dropped connection ends the work in flight on it" — a
// server→client request pending when the client disconnects must reject and be
// cleaned up (not leak a forever-pending promise).
test("a pending server→client request rejects when the client disconnects", async (t) => {
  let markRejected!: (e: Error) => void;
  const rejected = new Promise<Error>((r) => (markRejected = r));
  const sockPath = await startServer(t, {
    askForever: async (_p, conn) => {
      // this outbound request is never answered; when the socket drops it must
      // reject so the handler unwinds rather than hanging forever
      await conn.request("neverAnswered", {}).catch((e: Error) => {
        markRejected(e);
        throw e;
      });
    },
  });
  const c = new Client(sockPath);
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "askForever" });
  // wait until the server's outbound request is actually pending
  await c.waitFor((ms) => ms.find((m) => m.method === "neverAnswered" && "id" in m), "server request");
  c.end(); // drop the connection with the request still pending
  const err = await withTimeout(rejected, "pending request rejection");
  assert.match(err.message, /connection closed/, "the pending request rejects on disconnect");
});

// handlers can refuse with structured errors
test("a handler throwing RpcError surfaces code, message, and data", async (t) => {
  const sockPath = await startServer(t, {
    boom: () => {
      throw new RpcError(7, "boom", { detail: true });
    },
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "boom" });
  const res = await c.next();
  assert.deepEqual(res.error, { code: 7, message: "boom", data: { detail: true } });
});

// --- lifecycle, id domain, and teardown robustness --------------------------

// transport.md handshake: the connection has three lifecycle states —
// uninitialized → initializing → initialized. `initialized` is committed ONLY
// after the initialize handler resolves successfully: while a deferred
// initialize is unresolved the connection is `initializing`, and an ordinary
// request pipelined in the same chunk must NOT run — it gets -32002. A rejected
// initialize returns the connection to `uninitialized` for a fresh-id retry.
test("a deferred initialize that rejects: a pipelined request gets -32002 and never runs", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ordinaryRan = false;
  let initCalls = 0;
  const sockPath = await startWireServer(t, {
    initialize: async () => {
      initCalls++;
      if (initCalls === 1) {
        await gate; // hold the handshake unresolved
        throw new RpcError(-32602, "version mismatch", { supported: [1] });
      }
      return { version: 1, serverInfo: TEST_HANDSHAKE.serverInfo };
    },
    mutate: () => {
      ordinaryRan = true;
      return { ok: true };
    },
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  const line1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() }) + "\n";
  const line2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "mutate" }) + "\n";
  c.socket.write(line1 + line2); // single write — arrives as one chunk

  // the ordinary request is answered -32002 WHILE initializing, before init resolves
  const res2 = await c.waitFor((ms) => ms.find((m) => m.id === 2), "mutate response");
  assert.equal(res2.error.code, -32002, "ordinary request is not-initialized while initializing");
  assert.equal(ordinaryRan, false, "the ordinary request did not run before initialize resolved");

  // let initialize reject; the connection returns to uninitialized
  release();
  const res1 = await c.waitFor((ms) => ms.find((m) => m.id === 1), "initialize response");
  assert.equal(res1.error.code, -32602);

  // a fresh-id initialize now succeeds (rejected init's own id is spent)
  c.send({ jsonrpc: "2.0", id: 3, method: "initialize", params: params() });
  const res3 = await c.waitFor((ms) => ms.find((m) => m.id === 3 && "result" in m), "retry init");
  assert.equal(res3.result.version, 1);
});

// transport.md: an inbound request id is spent for the connection's LIFETIME
// regardless of how the first request was answered — including ids answered
// with -32002 (pre-init) or -32601 (unknown method). A retry must use a fresh id.
test("an id spent on a rejected request stays spent (reused -32002 / -32601 ids are -32600)", async (t) => {
  const sockPath = await startServer(t, { known: () => ({ ok: true }) });
  const c = new Client(sockPath);
  t.after(() => c.end());

  // a pre-init request spends id 7 with -32002
  c.send({ jsonrpc: "2.0", id: 7, method: "known" });
  const pre = await c.waitFor((ms) => ms.find((m) => m.id === 7), "pre-init");
  assert.equal(pre.error.code, -32002);

  // initialize on a fresh id
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.waitFor((ms) => ms.find((m) => m.id === 1 && "result" in m), "init");

  // an unknown method spends id 8 with -32601
  c.send({ jsonrpc: "2.0", id: 8, method: "nosuch" });
  const unk = await c.waitFor((ms) => ms.find((m) => m.id === 8), "unknown");
  assert.equal(unk.error.code, -32601);

  // reusing id 7 (was -32002) is now -32600 — the id is spent
  c.send({ jsonrpc: "2.0", id: 7, method: "known" });
  const r7 = await c.waitFor((ms) => (ms.filter((m) => m.id === 7)[1]), "id7 reuse");
  assert.equal(r7.error.code, -32600, "an id answered -32002 stays spent");

  // reusing id 8 (was -32601) is now -32600 — the id is spent
  c.send({ jsonrpc: "2.0", id: 8, method: "known" });
  const r8 = await c.waitFor((ms) => (ms.filter((m) => m.id === 8)[1]), "id8 reuse");
  assert.equal(r8.error.code, -32600, "an id answered -32601 stays spent");
});

// transport.md envelope: the request-id domain is string or finite number; an
// id present but of any other type is an invalid request (-32600), answered
// with id null (the id is not a usable correlation key).
test("a request id that is not a string or finite number is rejected -32600 with id null", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  for (const badId of [true, { a: 1 }, [1, 2], null]) {
    c.send({ jsonrpc: "2.0", id: badId, method: "initialize", params: params() });
    const res = await c.next();
    assert.equal(res.error.code, -32600, `id ${JSON.stringify(badId)} is invalid`);
    assert.equal(res.id, null);
  }
});

// transport.md envelope: tag omission is tolerated, but a present `jsonrpc`
// that is not "2.0" is an invalid request.
test("a present jsonrpc tag that is not \"2.0\" is rejected -32600", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "1.0", id: 1, method: "initialize", params: params() });
  const res = await c.next();
  assert.equal(res.error.code, -32600);
  assert.equal(res.id, 1, "a valid id is echoed");
});

// transport.md envelope: a response carries exactly one of result/error; one
// carrying both is invalid and is dropped, never crashing the connection.
test("a response carrying both result and error is dropped, connection survives", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 999, result: {}, error: { code: 1, message: "x" } });
  await c.expectSilence();
  // still healthy
  c.send({ jsonrpc: "2.0", id: 2, method: "nosuch" });
  const res = await c.next();
  assert.equal(res.error.code, -32601);
});

// transport.md handshake: clientInfo is identification-only and OPTIONAL —
// initialize with no clientInfo succeeds.
test("initialize with no clientInfo succeeds", async (t) => {
  const c = new Client(await startServer(t));
  t.after(() => c.end());
  const p = params();
  delete (p as Record<string, unknown>).clientInfo;
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: p });
  const res = await c.next();
  assert.equal(res.result.version, 1);
});

// a throwing close listener is caught so teardown continues to the others
test("a throwing close listener does not abort teardown of the rest", async (t) => {
  let secondRan!: () => void;
  const secondDone = new Promise<void>((r) => (secondRan = r));
  const sockPath = await startServer(t, {
    arm: (_p, conn) => {
      conn.onClose(() => {
        throw new Error("boom in close listener");
      });
      conn.onClose(() => secondRan());
      return { ok: true };
    },
  });
  const c = new Client(sockPath);
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "arm" });
  await c.waitFor((ms) => ms.find((m) => m.id === 2 && "result" in m), "arm");
  c.end(); // triggers the connection's close listeners on the server
  await withTimeout(secondDone, "the second close listener still runs");
});

// an RpcError whose data cannot be serialized still answers the request with a
// guaranteed-serializable -32603, rather than dropping the response entirely.
test("an RpcError with unserializable data still answers -32603", async (t) => {
  const sockPath = await startServer(t, {
    boom: () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic; // JSON.stringify throws on this
      throw new RpcError(7, "boom", cyclic);
    },
  });
  const c = new Client(sockPath);
  t.after(() => c.end());
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "boom" });
  const res = await c.next();
  assert.equal(res.id, 2);
  assert.equal(res.error.code, -32603, "the request is answered rather than left hanging");
});

// transport.md: a server→client request made after the connection is closed
// rejects immediately rather than leaking a forever-pending promise.
test("a server→client request made after close rejects immediately", async (t) => {
  let settle!: (e: Error) => void;
  const outcome = new Promise<Error>((r) => (settle = r));
  const sockPath = await startServer(t, {
    arm: (_p, conn) => {
      conn.onClose(() => {
        conn.request("tooLate", {}).then(
          () => settle(new Error("resolved unexpectedly")),
          (e: Error) => settle(e),
        );
      });
      return { ok: true };
    },
  });
  const c = new Client(sockPath);
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: params() });
  await c.next();
  c.send({ jsonrpc: "2.0", id: 2, method: "arm" });
  await c.waitFor((ms) => ms.find((m) => m.id === 2 && "result" in m), "arm");
  c.end();
  const err = await withTimeout(outcome, "post-close request settles");
  assert.match(err.message, /connection closed/, "post-close request rejects, not hangs");
});
