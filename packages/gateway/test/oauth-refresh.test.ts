import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type OAuthAuth,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { makeRespondHandlers } from "../src/wire/respond.ts";
import {
  Client,
  ObservableCredentialStore,
  connectClient,
  fakeModel,
  initHandler,
  startWireServer,
  tmpDir,
  withTimeout,
} from "./helpers.ts";

// gateway.md V0: "OAuth token refresh serializes with [the in-process writes]
// so concurrent requests cannot double-refresh." This is enforced by pi-ai's
// resolveStoredOAuth (double-checked locking over the credential store's
// serialized modify): two concurrent respond calls that both see an expired
// token must refresh exactly once and both proceed on the rotated credential,
// with the store written exactly once (no lost update). Built on the REAL
// Models.getAuth + FileCredentialStore with a scripted OAuth provider whose
// refresh is gated so the concurrent window is deterministic.

const MODEL_REF = { provider: "gated", id: "gated-model" };
const CONTEXT = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** A provider stream that records the api key it was handed (the resolved,
 * refreshed OAuth-derived key) and finishes a trivial turn. */
function recordingApi(recordedKeys: (string | undefined)[]): ProviderStreams {
  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "gated-api",
    provider: "gated",
    model: "gated-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
  const api: ProviderStreams = {
    stream(model, context, options) {
      return api.streamSimple(model, context, options);
    },
    streamSimple(_model, _context, options) {
      recordedKeys.push(options?.apiKey);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: finalMessage });
      stream.push({ type: "done", reason: "stop", message: finalMessage });
      stream.end();
      return stream;
    },
  };
  return api;
}

test("respond: concurrent responds with an expired OAuth token refresh exactly once", async (t: TestContext) => {
  const store = new ObservableCredentialStore(tmpDir(t, "pino-oauth-refresh-"));

  // gate the refresh so both requests are provably in flight across it
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((r) => (releaseRefresh = r));
  let refreshCalls = 0;
  let refreshEntered!: () => void;
  const refreshEnteredP = new Promise<void>((r) => (refreshEntered = r));

  const oauth: OAuthAuth = {
    name: "Gated OAuth",
    login: async () => {
      throw new Error("login must not be called");
    },
    refresh: async () => {
      refreshCalls++;
      refreshEntered();
      await refreshGate;
      // the rotated credential, valid far into the future
      return { type: "oauth", access: "fresh-access-token", refresh: "refresh-2", expires: Date.now() + 3_600_000 };
    },
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };

  const recordedKeys: (string | undefined)[] = [];
  const models = createModels({ credentials: store });
  models.setProvider(
    createProvider({
      id: "gated",
      name: "Gated",
      auth: { oauth },
      models: [fakeModel("gated", "gated-model", { api: "gated-api" })],
      api: recordingApi(recordedKeys),
    }),
  );

  // a long-expired stored OAuth credential (expires in the distant past)
  await store.modify("gated", async () => ({ type: "oauth", access: "stale-access", refresh: "refresh-1", expires: 1 }));
  assert.equal(store.writes, 1, "baseline: the seed write");

  const { respond, cancel } = makeRespondHandlers(models);
  const sockPath = await startWireServer(t, { initialize: initHandler(), respond, cancel });
  const c: Client = await connectClient(t, sockPath);

  // two concurrent responds for the one provider, on the same connection
  const resAP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });
  const resBP = c.response(3);
  c.send({ jsonrpc: "2.0", id: 3, method: "respond", params: { model: MODEL_REF, context: CONTEXT } });

  // wait until the (single) refresh is in flight AND both requests have entered
  // the serialized modify queue (seed=1, request A=2, request B=3), so B is
  // provably parked behind A's refresh — an unserialized store would let B
  // refresh too. Deterministic barrier, no sleep.
  await withTimeout(refreshEnteredP, "refresh entered");
  await withTimeout(store.waitForModifyCalls(3), "both requests queued behind refresh");
  releaseRefresh();

  const resA = await resAP;
  const resB = await resBP;

  // both turns completed successfully on the rotated credential
  assert.equal(resA.result.message.content[0].text, "ok");
  assert.equal(resB.result.message.content[0].text, "ok");

  // refresh ran exactly once despite two concurrent expired-token requests
  assert.equal(refreshCalls, 1, "OAuth refresh serialized: exactly one refresh for two concurrent requests");

  // both provider calls ran with the refreshed access token (never the stale one)
  assert.deepEqual(recordedKeys, ["fresh-access-token", "fresh-access-token"]);

  // the rotated credential was persisted, exactly once beyond the seed (no lost update)
  assert.equal(store.writes, 2, "one seed write + one refresh write");
  const stored = await store.read("gated");
  assert.equal(stored?.type, "oauth");
  assert.equal(stored?.type === "oauth" ? stored.access : undefined, "fresh-access-token");
  assert.equal(stored?.type === "oauth" ? stored.refresh : undefined, "refresh-2");
  assert.ok(stored?.type === "oauth" && stored.expires > Date.now(), "persisted token is the rotated, unexpired one");
});
