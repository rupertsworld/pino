import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type AuthContext,
  type AuthLoginCallbacks,
  type MutableModels,
  type OAuthAuth,
} from "@earendil-works/pi-ai";
import type { MethodHandler } from "@pino-agent/transport";
import { makeAuthStatus } from "../src/wire/auth-status.ts";
import { makeLogin } from "../src/wire/login.ts";
import { makeLogout } from "../src/wire/logout.ts";
import {
  Client,
  ObservableCredentialStore,
  connectClient,
  fakeAuthContext,
  fakeModel,
  initHandler,
  neverStream,
  onAbort,
  startWireServer,
  tmpDir,
} from "./helpers.ts";

// --- scripted auth flows ------------------------------------------------------
// Hand-rolled ProviderAuth whose login drives the AuthLoginCallbacks exactly
// the way pi-ai's stock flows do: prompt() resolves the entered string and
// rejects on cancel/abort; notify() is fire-and-forget (pi-ai auth/types.d.ts).

/** Records each login's flow-level signal so tests can assert it fires, plus
 * counters proving how many times the flow ran and how many prompt answers it
 * observed — so a late/duplicate prompt response can be shown to resolve the
 * flow's prompt exactly once. */
interface Probe {
  signals: (AbortSignal | undefined)[];
  promptResolutions: number;
  loginRuns: number;
}

function probe(): Probe {
  return { signals: [], promptResolutions: 0, loginRuns: 0 };
}

/** api_key flow: one secret prompt, credential from the entered key. */
function scriptedApiKey(p?: Probe): ApiKeyAuth {
  return {
    name: "Fake API key",
    login: async (cb: AuthLoginCallbacks) => {
      if (p) p.loginRuns++;
      p?.signals.push(cb.signal);
      const key = await cb.prompt({ type: "secret", message: "Enter your key", placeholder: "sk-..." });
      if (p) p.promptResolutions++;
      return { type: "api_key", key };
    },
    // stock stored-credential-wins resolution (source: "stored credential")
    resolve: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]).resolve,
  };
}

/** oauth flow: an auth_url announcement, then a manual code paste. */
function scriptedOAuth(p?: Probe): OAuthAuth {
  return {
    name: "Fake OAuth",
    login: async (cb: AuthLoginCallbacks) => {
      p?.signals.push(cb.signal);
      cb.notify({ type: "auth_url", url: "https://example.test/authorize", instructions: "open it yourself" });
      const code = await cb.prompt({ type: "manual_code", message: "Paste the code" });
      if (p) p.promptResolutions++;
      return { type: "oauth", access: `access-${code}`, refresh: "refresh-token-1", expires: 9999999999999 };
    },
    refresh: async (c) => c,
    toAuth: async (c) => ({ apiKey: c.access }),
  };
}

/** A login that fails after the flow started. */
function throwingApiKey(message: string): ApiKeyAuth {
  return {
    name: "Fake API key",
    login: async () => {
      throw new Error(message);
    },
    resolve: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]).resolve,
  };
}

// --- fixture -------------------------------------------------------------------

interface Fixture {
  models: MutableModels;
  store: ObservableCredentialStore;
  ctx: AuthContext;
  sockPath: string;
  /** Resolves when the most recently started `login` handler invocation
   * settles (fulfilled or rejected) — the login task's settlement, so a test
   * can gate on "the flow is definitively done" instead of sleeping. */
  loginSettled: () => Promise<void>;
}

async function fixture(t: TestContext, env: Record<string, string> = {}): Promise<Fixture> {
  const store = new ObservableCredentialStore(tmpDir(t, "pino-login-state-"));
  const models = createModels({ credentials: store });
  const ctx = fakeAuthContext(env);

  let settledP: Promise<void> = Promise.resolve();
  const rawLogin = makeLogin(models, store, () => store.secretValues());
  const login: MethodHandler = (params, conn, c) => {
    let settle!: () => void;
    settledP = new Promise<void>((r) => (settle = r));
    return Promise.resolve(rawLogin(params, conn, c)).then(
      (v) => {
        settle();
        return v;
      },
      (e) => {
        settle();
        throw e;
      },
    );
  };

  const sockPath = await startWireServer(t, {
    initialize: initHandler(),
    authStatus: makeAuthStatus(models, store, ctx),
    login,
    logout: makeLogout(store),
  });
  return { models, store, ctx, sockPath, loginSettled: () => settledP };
}

function connect(t: TestContext, f: Fixture): Promise<Client> {
  return connectClient(t, f.sockPath);
}

function setProvider(f: Fixture, auth: { apiKey?: ApiKeyAuth; oauth?: OAuthAuth }, id = "fake"): void {
  f.models.setProvider(
    createProvider({ id, name: "Fake Provider", auth, models: [fakeModel(id, `${id}-model`)], api: neverStream }),
  );
}

// --- api_key flow ----------------------------------------------------------------

// inference.md authPrompt: "Request — a question. The response is the user's
// answer, {value: string}". The prompt must be a real server→client REQUEST
// (it has an id and awaits the response); gateway.md: "login bridges pi-ai's
// two flow callbacks to the wire (question → authPrompt ...)".
test("login: api_key flow — authPrompt is a server→client request, credential persists", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });

  const prompt = await c.serverRequest("authPrompt");
  assert.equal(typeof prompt.id, "number", "authPrompt is a request: it carries an id");
  // inference.md authPrompt shapes: {type:"secret", message, placeholder?} —
  // and nothing else (pi-ai's per-prompt `signal` must not leak to the wire)
  assert.deepEqual(prompt.params, { type: "secret", message: "Enter your key", placeholder: "sk-..." });

  c.respondTo(prompt.id, { value: "sk-fresh-key-123" });
  const res = await resP;
  // inference.md login result: {provider, source?} — source follows
  // authStatus's semantics ("stored credential" for a stored api key)
  assert.deepEqual(res.result, { provider: "fake", source: "stored credential" });

  // gateway.md: "a completed flow persists the credential"
  assert.deepEqual(await f.store.read("fake"), { type: "api_key", key: "sk-fresh-key-123" });

  // the single offered method is chosen without a select prompt
  const selects = c.messages.filter((m) => m.method === "authPrompt" && m.params?.type === "select");
  assert.equal(selects.length, 0, "no select prompt when the provider offers one method");

  // authStatus flips to configured:true
  const status = await c.request(3, "authStatus");
  assert.deepEqual(status.result.providers, [
    { provider: "fake", name: "Fake Provider", methods: ["api_key"], configured: true, source: "stored credential" },
  ]);
});

// --- oauth flow --------------------------------------------------------------------

// inference.md authEvent: "Notification — display-only flow information,
// nothing owed back" — no id on the wire. gateway.md: "announcement →
// authEvent"; manual paste is canonical.
test("login: oauth flow — authEvent is a notification, manual_code prompt completes it", async (t) => {
  const f = await fixture(t);
  setProvider(f, { oauth: scriptedOAuth() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });

  const event = await c.waitFor((ms) => ms.find((m) => m.method === "authEvent"), "authEvent");
  assert.ok(!("id" in event), "authEvent is a notification: no id");
  assert.deepEqual(event.params, {
    type: "auth_url",
    url: "https://example.test/authorize",
    instructions: "open it yourself",
  });

  const prompt = await c.serverRequest("authPrompt");
  assert.deepEqual(prompt.params, { type: "manual_code", message: "Paste the code" });
  c.respondTo(prompt.id, { value: "CODE-9" });

  const res = await resP;
  assert.deepEqual(res.result, { provider: "fake", source: "OAuth" });
  assert.deepEqual(await f.store.read("fake"), {
    type: "oauth",
    access: "access-CODE-9",
    refresh: "refresh-token-1",
    expires: 9999999999999,
  });

  const status = await c.request(3, "authStatus");
  assert.deepEqual(status.result.providers, [
    { provider: "fake", name: "Fake Provider", methods: ["oauth"], configured: true, source: "OAuth" },
  ]);
});

// --- method selection ----------------------------------------------------------------

// inference.md login: "when method is omitted and the provider supports
// several, the gateway asks via an authPrompt select" — options are the two
// flows, labeled with pi-ai's display names; select answers carry "the chosen
// option id".
test("login: both methods offered and none named → select prompt chooses the flow", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey(), oauth: scriptedOAuth() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });

  const select = await c.serverRequest("authPrompt");
  assert.equal(select.params.type, "select");
  assert.deepEqual(select.params.options, [
    { id: "api_key", label: "Fake API key" },
    { id: "oauth", label: "Fake OAuth" },
  ]);
  c.respondTo(select.id, { value: "oauth" });

  // the chosen flow runs: oauth announces its URL then asks for the code
  const prompt = await c.serverRequest("authPrompt", 1);
  assert.equal(prompt.params.type, "manual_code");
  c.respondTo(prompt.id, { value: "XYZ" });

  const res = await resP;
  assert.deepEqual(res.result, { provider: "fake", source: "OAuth" });
  assert.deepEqual((await f.store.read("fake"))?.type, "oauth");
});

test("login: explicit method skips the select", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey(), oauth: scriptedOAuth() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake", method: "api_key" } });
  const prompt = await c.serverRequest("authPrompt");
  assert.equal(prompt.params.type, "secret", "went straight to the api_key flow");
  c.respondTo(prompt.id, { value: "sk-direct-1234" });
  const res = await resP;
  assert.deepEqual(res.result, { provider: "fake", source: "stored credential" });
});

// select answered with something that is not an offered option id: the flow
// cannot proceed — login_failed
test("login: select answered with an unknown option id is code 5", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey(), oauth: scriptedOAuth() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const select = await c.serverRequest("authPrompt");
  c.respondTo(select.id, { value: "carrier_pigeon" });
  const res = await resP;
  assert.equal(res.error.code, 5);
});

// --- failures ------------------------------------------------------------------------

// inference.md errors: code 5 login_failed on "auth flow failed, declined, or
// aborted"; authPrompt response "{cancelled: true} when the user declines" —
// which REJECTS pi-ai's prompt promise and aborts the flow.
test("login: {cancelled:true} declines the prompt → code 5, nothing stored", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const prompt = await c.serverRequest("authPrompt");
  c.respondTo(prompt.id, { cancelled: true });
  const res = await resP;
  assert.equal(res.error.code, 5);
  assert.equal(await f.store.read("fake"), undefined, "declined flow persists nothing");
});

test("login: a rejecting provider flow is code 5", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: throwingApiKey("token exchange exploded") });
  const c = await connect(t, f);
  const res = await c.request(2, "login", { provider: "fake" });
  assert.equal(res.error.code, 5);
  assert.match(res.error.message, /token exchange exploded/);
});

test("login: unknown provider is code 5", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);
  const res = await c.request(2, "login", { provider: "nope" });
  assert.equal(res.error.code, 5);
});

test("login: a method the provider cannot drive is code 5", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() }); // no oauth surface
  // ambient-only api_key: resolve but no login (pi-ai: "Absent = ambient-only")
  setProvider(f, { apiKey: { name: "Ambient", resolve: envApiKeyAuth("Ambient", ["AMB"]).resolve } }, "ambient");
  const c = await connect(t, f);
  const res = await c.request(2, "login", { provider: "fake", method: "oauth" });
  assert.equal(res.error.code, 5);
  const res2 = await c.request(3, "login", { provider: "ambient", method: "api_key" });
  assert.equal(res2.error.code, 5);
  const res3 = await c.request(4, "login", { provider: "ambient" });
  assert.equal(res3.error.code, 5, "no interactive method at all is login_failed");
});

test("login: malformed params are invalid params (-32602)", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);
  const res = await c.request(2, "login", {});
  assert.equal(res.error.code, -32602);
  const res2 = await c.request(3, "login", { provider: "fake", method: "telepathy" });
  assert.equal(res2.error.code, -32602);
});

// --- one login per connection -----------------------------------------------------------

// inference.md: "at most one login may be in flight per connection (a second
// is rejected with login_failed)"
test("login: a second login on the same connection is rejected; the first survives", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);

  const firstP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const prompt = await c.serverRequest("authPrompt");

  const second = await c.request(3, "login", { provider: "fake" });
  assert.equal(second.error.code, 5, "second login while one is in flight → login_failed");

  // the first flow is untouched and completes
  c.respondTo(prompt.id, { value: "sk-first-flow-key" });
  const first = await firstP;
  assert.deepEqual(first.result, { provider: "fake", source: "stored credential" });

  // and the slot is freed: a later login on the same connection works
  const thirdP = c.response(4);
  c.send({ jsonrpc: "2.0", id: 4, method: "login", params: { provider: "fake" } });
  const prompt2 = await c.serverRequest("authPrompt", 1);
  c.respondTo(prompt2.id, { value: "sk-third-flow-key" });
  const third = await thirdP;
  assert.equal(third.result.provider, "fake");
});

// --- connection close aborts ------------------------------------------------------------

// inference.md: "Connection close aborts the flow." The flow-level signal the
// gateway passes as AuthLoginCallbacks.signal must fire, and the pending
// authPrompt is abandoned (nothing is persisted).
test("login: connection close mid-prompt aborts the flow", async (t) => {
  const f = await fixture(t);
  const pr = probe();
  setProvider(f, { apiKey: scriptedApiKey(pr) });
  const c = await connect(t, f);

  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  await c.serverRequest("authPrompt");
  assert.equal(pr.signals.length, 1);
  assert.ok(pr.signals[0] instanceof AbortSignal, "gateway passes a flow-level signal");
  assert.equal(pr.signals[0].aborted, false);

  c.end(); // drop the connection while the prompt is pending
  await onAbort(pr.signals[0]);
  assert.equal(pr.signals[0].aborted, true, "connection close fires the login's abort signal");

  // no sleep: gate on the login task's definitive settlement, then prove the
  // abandoned flow touched the store zero times (never persisted anything).
  await f.loginSettled();
  assert.equal(f.store.modifyCalls, 0, "aborted flow never reached the credential store");
  assert.equal(f.store.writes, 0, "aborted flow persisted nothing");
  assert.equal(await f.store.read("fake"), undefined);
});

// --- connection scoping -------------------------------------------------------------------

// inference.md: "Login flows are connection-scoped: prompts and events go
// only to the connection that initiated the login"
test("login: a second connected client sees none of the first's prompts or events", async (t) => {
  const f = await fixture(t);
  setProvider(f, { oauth: scriptedOAuth() });
  const c1 = await connect(t, f);
  const c2 = await connect(t, f);

  const resP = c1.response(2);
  c1.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const prompt = await c1.serverRequest("authPrompt");
  c1.respondTo(prompt.id, { value: "SCOPED" });
  await resP;

  // Barrier instead of immediate inspection: round-trip a sentinel request on
  // c2. Its response cannot arrive before anything the server had already
  // queued for c2, so once it lands, any mis-routed login traffic would be
  // visible. Then assert bounded silence specifically for authPrompt/authEvent.
  const sentinel = await c2.request(2, "authStatus");
  assert.ok(Array.isArray(sentinel.result.providers), "c2's own request round-trips");
  const leaked = c2.messages.filter((m) => m.method === "authPrompt" || m.method === "authEvent");
  assert.deepEqual(leaked, [], "no login traffic crosses to another connection");
});

// inference.md: "Concurrent logins for one provider from different
// connections are last-write-wins on the stored credential."
test("login: concurrent logins from two connections are last-write-wins", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c1 = await connect(t, f);
  const c2 = await connect(t, f);

  const res1P = c1.response(2);
  c1.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const res2P = c2.response(2);
  c2.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });

  const p1 = await c1.serverRequest("authPrompt");
  const p2 = await c2.serverRequest("authPrompt");

  c1.respondTo(p1.id, { value: "sk-first-writer" });
  await res1P;
  c2.respondTo(p2.id, { value: "sk-second-writer" });
  await res2P;

  assert.deepEqual(await f.store.read("fake"), { type: "api_key", key: "sk-second-writer" });
});

// --- logout ----------------------------------------------------------------------------------

// inference.md logout: "Deletes the stored credential; ambient sources
// (environment variables) are unaffected. Result: {}."
test("logout: removes the stored credential and authStatus flips back", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const prompt = await c.serverRequest("authPrompt");
  c.respondTo(prompt.id, { value: "sk-to-be-removed" });
  await resP;
  assert.notEqual(await f.store.read("fake"), undefined);

  const out = await c.request(3, "logout", { provider: "fake" });
  assert.deepEqual(out.result, {});
  assert.equal(await f.store.read("fake"), undefined);

  const status = await c.request(4, "authStatus");
  assert.deepEqual(status.result.providers, [
    { provider: "fake", name: "Fake Provider", methods: ["api_key"], configured: false },
  ]);
});

test("logout: unknown or never-configured provider still succeeds with {}", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);
  const res = await c.request(2, "logout", { provider: "never-heard-of-it" });
  assert.deepEqual(res.result, {});
});

test("logout: malformed params are invalid params (-32602)", async (t) => {
  const f = await fixture(t);
  const c = await connect(t, f);
  const res = await c.request(2, "logout", {});
  assert.equal(res.error.code, -32602);
});

// --- redaction (slice C carry-over) ------------------------------------------------------------

// gateway.md: "known secret patterns redacted". Stored-credential values are
// secrets not present in env — the login path receives them as extra
// redaction targets, so a non-sk-shaped stored token (gho_, ya29., OAuth
// access tokens) surfacing in a flow error never reaches the wire verbatim.
test("login: a stored credential token in a flow error is redacted from the wire error", async (t) => {
  const f = await fixture(t);
  // an existing stored OAuth token for ANOTHER provider, not sk-shaped
  await f.store.modify("other", async () => ({
    type: "oauth",
    access: "gho_storedtokenvalue123",
    refresh: "ya29.refreshvalue456",
    expires: 1,
  }));
  setProvider(f, { apiKey: throwingApiKey("exchange failed for gho_storedtokenvalue123 (refresh ya29.refreshvalue456)") });
  const c = await connect(t, f);
  const res = await c.request(2, "login", { provider: "fake" });
  assert.equal(res.error.code, 5);
  assert.ok(!res.error.message.includes("gho_storedtokenvalue123"), "stored access token redacted");
  assert.ok(!res.error.message.includes("ya29.refreshvalue456"), "stored refresh token redacted");
  assert.match(res.error.message, /\[redacted\]/);
});

// the value the user just typed into a secret prompt is a secret too — a flow
// that echoes it into its failure must not leak it onto the wire
test("login: an entered secret echoed by a failing flow is redacted", async (t) => {
  const f = await fixture(t);
  setProvider(f, {
    apiKey: {
      name: "Fake API key",
      login: async (cb: AuthLoginCallbacks) => {
        const key = await cb.prompt({ type: "secret", message: "Enter your key" });
        throw new Error(`key ${key} was rejected by the provider`);
      },
      resolve: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]).resolve,
    },
  });
  const c = await connect(t, f);
  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const prompt = await c.serverRequest("authPrompt");
  c.respondTo(prompt.id, { value: "not-sk-shaped-supersecret" });
  const res = await resP;
  assert.equal(res.error.code, 5);
  assert.ok(!res.error.message.includes("not-sk-shaped-supersecret"), "entered secret redacted");
  assert.match(res.error.message, /\[redacted\]/);
});

// inference.md authPrompt response is {value: string} | {cancelled: true}; a
// malformed response (neither shape) fails the flow, not the process —
// login_failed (code 5), and the connection stays usable afterward
test("login: malformed authPrompt response fails the login without crashing", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const prompt = await c.serverRequest("authPrompt");
  c.respondTo(prompt.id, { value: 123 }); // not a string, not {cancelled:true}
  const res = await resP;
  assert.equal(res.error.code, 5);
  assert.equal(await f.store.read("fake"), undefined, "nothing persisted on a failed flow");

  // connection still works: a fresh login on the same connection succeeds
  const res2P = c.response(3);
  c.send({ jsonrpc: "2.0", id: 3, method: "login", params: { provider: "fake" } });
  const prompt2 = await c.serverRequest("authPrompt", 1);
  c.respondTo(prompt2.id, { value: "sk-recovered" });
  assert.equal((await res2P).result.provider, "fake");
});

// inference.md: "the gateway ignores responses to prompts whose flow has
// already moved on" — a duplicate/late response to a settled authPrompt id is
// dropped silently, no double-resolve, no crash
test("login: a late duplicate response to a settled authPrompt is ignored", async (t) => {
  const f = await fixture(t);
  const pr = probe();
  setProvider(f, { apiKey: scriptedApiKey(pr) });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const prompt = await c.serverRequest("authPrompt");
  c.respondTo(prompt.id, { value: "sk-first-wins" });
  const res = await resP;
  assert.deepEqual(res.result, { provider: "fake", source: "stored credential" });

  // fire a second, late response to the same (now-settled) prompt id
  c.respondTo(prompt.id, { value: "sk-too-late" });

  // no sleep: a protocol barrier. authStatus is processed after the late
  // duplicate that preceded it on the same ordered connection, so once it
  // replies the duplicate has been fully handled (and dropped).
  const status = await c.request(4, "authStatus");
  assert.equal(status.result.providers.find((p: { provider: string }) => p.provider === "fake").configured, true);

  // the prompt resolved exactly once and the credential was written exactly
  // once — the duplicate neither re-resolved the flow nor wrote again
  assert.equal(pr.promptResolutions, 1, "the late duplicate did not re-resolve the prompt");
  assert.equal(f.store.writes, 1, "the credential was written exactly once");
  assert.deepEqual(await f.store.read("fake"), { type: "api_key", key: "sk-first-wins" });
});

// --- prompt / event union coverage & ambient survival -----------------------

// inference.md logout: "ambient sources (environment variables) are
// unaffected." With a competing ambient key configured, logging out must
// delete the STORED credential yet leave the provider configured via the env
// var — the exact behavior the env-empty flip test cannot prove.
test("logout: deletes the stored credential but ambient env credential survives", async (t) => {
  const f = await fixture(t, { FAKE_API_KEY: "sk-ambient-survives-me" });
  setProvider(f, { apiKey: scriptedApiKey() });
  const c = await connect(t, f);

  // a stored credential competing with the ambient env var
  await f.store.modify("fake", async () => ({ type: "api_key", key: "sk-stored-losing" }));
  // stored wins while present
  const before = await c.request(2, "authStatus");
  assert.equal(before.result.providers[0].source, "stored credential");

  const out = await c.request(3, "logout", { provider: "fake" });
  assert.deepEqual(out.result, {});
  assert.equal(await f.store.read("fake"), undefined, "stored credential deleted");

  // ambient env credential is untouched: provider stays configured, now via env
  const after = await c.request(4, "authStatus");
  assert.deepEqual(after.result.providers, [
    { provider: "fake", name: "Fake Provider", methods: ["api_key"], configured: true, source: "FAKE_API_KEY" },
  ]);
});

// inference.md authPrompt "text" shape is {type, message, placeholder?}; the
// optional placeholder is present or omitted (never null) per the prompt.
test("login: text prompts carry the text shape with placeholder present and absent", async (t) => {
  const f = await fixture(t);
  setProvider(f, {
    apiKey: {
      name: "Fake API key",
      login: async (cb: AuthLoginCallbacks) => {
        const org = await cb.prompt({ type: "text", message: "Org name", placeholder: "acme" });
        const region = await cb.prompt({ type: "text", message: "Region" });
        return { type: "api_key", key: `${org}-${region}` };
      },
      resolve: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]).resolve,
    },
  });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  const withPlaceholder = await c.serverRequest("authPrompt");
  assert.deepEqual(withPlaceholder.params, { type: "text", message: "Org name", placeholder: "acme" });
  c.respondTo(withPlaceholder.id, { value: "acme-corp" });

  const withoutPlaceholder = await c.serverRequest("authPrompt", 1);
  assert.deepEqual(withoutPlaceholder.params, { type: "text", message: "Region" }, "placeholder omitted, not null");
  c.respondTo(withoutPlaceholder.id, { value: "eu" });

  const res = await resP;
  assert.equal(res.result.provider, "fake");
  assert.deepEqual(await f.store.read("fake"), { type: "api_key", key: "acme-corp-eu" });
});

// inference.md authEvent union: device_code (with optional interval/expiry) and
// progress are display-only notifications carried through verbatim.
test("login: device_code and progress authEvents reach the wire in their union shapes", async (t) => {
  const f = await fixture(t);
  setProvider(f, {
    oauth: {
      name: "Fake OAuth",
      login: async (cb: AuthLoginCallbacks) => {
        cb.notify({
          type: "device_code",
          userCode: "WDJB-MJHT",
          verificationUri: "https://example.test/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        });
        cb.notify({ type: "progress", message: "waiting for authorization" });
        const code = await cb.prompt({ type: "manual_code", message: "Paste the code" });
        return { type: "oauth", access: `a-${code}`, refresh: "r", expires: 9999999999999 };
      },
      refresh: async (cred) => cred,
      toAuth: async (cred) => ({ apiKey: cred.access }),
    },
  });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });

  const device = await c.waitFor((ms) => ms.find((m) => m.method === "authEvent" && m.params?.type === "device_code"), "device_code event");
  assert.ok(!("id" in device), "authEvent is a notification");
  assert.deepEqual(device.params, {
    type: "device_code",
    userCode: "WDJB-MJHT",
    verificationUri: "https://example.test/device",
    intervalSeconds: 5,
    expiresInSeconds: 900,
  });
  const progress = await c.waitFor((ms) => ms.find((m) => m.method === "authEvent" && m.params?.type === "progress"), "progress event");
  assert.deepEqual(progress.params, { type: "progress", message: "waiting for authorization" });

  const prompt = await c.serverRequest("authPrompt");
  c.respondTo(prompt.id, { value: "CODE-42" });
  assert.equal((await resP).result.source, "OAuth");
});

// inference.md authPrompt select options carry {id, label, description?}; a
// flow-issued select proves description is projected when present and omitted
// when absent.
test("login: a flow-issued select prompt carries option descriptions and omits absent ones", async (t) => {
  const f = await fixture(t);
  setProvider(f, {
    apiKey: {
      name: "Fake API key",
      login: async (cb: AuthLoginCallbacks) => {
        const env = await cb.prompt({
          type: "select",
          message: "Pick environment",
          options: [
            { id: "prod", label: "Production", description: "serves live traffic" },
            { id: "staging", label: "Staging" },
          ],
        });
        return { type: "api_key", key: `key-${env}` };
      },
      resolve: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]).resolve,
    },
  });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake", method: "api_key" } });
  const select = await c.serverRequest("authPrompt");
  assert.deepEqual(select.params, {
    type: "select",
    message: "Pick environment",
    options: [
      { id: "prod", label: "Production", description: "serves live traffic" },
      { id: "staging", label: "Staging" },
    ],
  });
  c.respondTo(select.id, { value: "prod" });
  const res = await resP;
  assert.deepEqual(await f.store.read("fake"), { type: "api_key", key: "key-prod" });
  assert.equal(res.result.provider, "fake");
});

// inference.md: "A prompt can become moot while pending (the flow resolved
// another way)." Distinct from the late-duplicate test: here the flow completes
// through a different route (a loopback-style callback) and aborts the pending
// prompt via AuthPrompt.signal. The login still succeeds, and a late
// {cancelled:true} to the abandoned prompt is ignored.
test("login: a prompt made moot by the flow completing elsewhere is abandoned; login still succeeds", async (t) => {
  const f = await fixture(t);
  setProvider(f, {
    oauth: {
      name: "Fake OAuth",
      login: async (cb: AuthLoginCallbacks) => {
        cb.notify({ type: "auth_url", url: "https://example.test/authorize" });
        // the manual-code prompt raced against an out-of-band callback; issue
        // it, then let the callback "win" and abort the pending prompt
        const promptSignal = new AbortController();
        const manual = cb.prompt({ type: "manual_code", message: "Paste the code", signal: promptSignal.signal });
        manual.catch(() => {}); // the abandoned prompt loses the race; never unhandled
        promptSignal.abort(); // the loopback callback resolved this step
        return { type: "oauth", access: "loopback-access", refresh: "r", expires: 9999999999999 };
      },
      refresh: async (cred) => cred,
      toAuth: async (cred) => ({ apiKey: cred.access }),
    },
  });
  const c = await connect(t, f);

  const resP = c.response(2);
  c.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "fake" } });
  // the prompt was sent to the wire before the flow moved on
  const prompt = await c.serverRequest("authPrompt");
  assert.equal(prompt.params.type, "manual_code");

  // the flow completed via the callback route: login succeeds with that cred
  const res = await resP;
  assert.deepEqual(res.result, { provider: "fake", source: "OAuth" });
  assert.deepEqual(await f.store.read("fake"), { type: "oauth", access: "loopback-access", refresh: "r", expires: 9999999999999 });

  // a late dismissal of the now-moot prompt is ignored; connection stays healthy
  c.respondTo(prompt.id, { cancelled: true });
  const status = await c.request(3, "authStatus");
  assert.equal(status.result.providers[0].configured, true);
});

// inference.md: login flows are connection-scoped. Two DIFFERENT providers
// logging in concurrently on separate connections complete independently, each
// persisting its own credential without cross-talk.
test("login: two providers logging in concurrently on separate connections don't cross", async (t) => {
  const f = await fixture(t);
  setProvider(f, { apiKey: scriptedApiKey() }, "alpha");
  setProvider(f, { apiKey: scriptedApiKey() }, "beta");
  const ca = await connect(t, f);
  const cb = await connect(t, f);

  const raP = ca.response(2);
  ca.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "alpha" } });
  const rbP = cb.response(2);
  cb.send({ jsonrpc: "2.0", id: 2, method: "login", params: { provider: "beta" } });

  const pa = await ca.serverRequest("authPrompt");
  const pb = await cb.serverRequest("authPrompt");
  ca.respondTo(pa.id, { value: "sk-alpha-key" });
  cb.respondTo(pb.id, { value: "sk-beta-key" });

  assert.equal((await raP).result.provider, "alpha");
  assert.equal((await rbP).result.provider, "beta");
  assert.deepEqual(await f.store.read("alpha"), { type: "api_key", key: "sk-alpha-key" });
  assert.deepEqual(await f.store.read("beta"), { type: "api_key", key: "sk-beta-key" });

  // neither connection saw the other's prompt
  assert.deepEqual(ca.messages.filter((m) => m.method === "authPrompt").length, 1);
  assert.deepEqual(cb.messages.filter((m) => m.method === "authPrompt").length, 1);
});

// inference.md errors: a failed login is code 5 and, crucially, must not
// clobber an already-stored credential — the flow only persists on success.
test("login: a failed login never overwrites an existing stored credential", async (t) => {
  const f = await fixture(t);
  await f.store.modify("fake", async () => ({ type: "api_key", key: "sk-preexisting-good" }));
  assert.equal(f.store.writes, 1, "baseline: the seed write");
  setProvider(f, { apiKey: throwingApiKey("token exchange exploded") });
  const c = await connect(t, f);

  const res = await c.request(2, "login", { provider: "fake" });
  assert.equal(res.error.code, 5);

  // no further write happened; the pre-existing credential is intact
  assert.equal(f.store.writes, 1, "the failed flow performed no write");
  assert.deepEqual(await f.store.read("fake"), { type: "api_key", key: "sk-preexisting-good" });
});
