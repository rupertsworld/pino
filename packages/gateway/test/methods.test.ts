import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type AuthContext,
  type MutableModels,
  type OAuthAuth,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { makeListModels } from "../src/wire/list-models.ts";
import { makeAuthStatus } from "../src/wire/auth-status.ts";
import { FileCredentialStore } from "../src/storage/credentials.ts";
import {
  Client,
  connectClient,
  fakeAuthContext,
  fakeModel,
  initHandler,
  neverStream,
  startWireServer,
  tmpDir,
} from "./helpers.ts";

/** An OAuthAuth that records refresh calls — authStatus must never trigger one. */
function recordingOAuth(refreshCalls: unknown[]): OAuthAuth {
  return {
    name: "Fake OAuth",
    login: async () => {
      throw new Error("login must not be called");
    },
    refresh: async (credential: OAuthCredential) => {
      refreshCalls.push(credential);
      throw new Error("refresh must not be called by authStatus");
    },
    toAuth: async () => ({ apiKey: "derived" }),
  };
}

interface Fixture {
  models: MutableModels;
  store: FileCredentialStore;
  ctx: AuthContext;
}

async function connect(t: TestContext, { models, store, ctx }: Fixture): Promise<Client> {
  const sockPath = await startWireServer(t, {
    initialize: initHandler(),
    listModels: makeListModels(models),
    authStatus: makeAuthStatus(models, store, ctx),
  });
  return connectClient(t, sockPath);
}

function fixture(t: TestContext, env: Record<string, string> = {}): Fixture {
  const store = new FileCredentialStore(tmpDir(t, "pino-methods-state-"));
  const models = createModels({ credentials: store });
  return { models, store, ctx: fakeAuthContext(env) };
}

// --- listModels ------------------------------------------------------------

// inference.md listModels: entries carry EXACTLY provider, id, name,
// reasoning, input, contextWindow, maxTokens — "gateway-internal fields
// (base URLs, headers, compat flags) are deliberately not exposed, and
// pricing is deferred".
test("listModels returns exactly the spec fields per entry", async (t) => {
  const f = fixture(t);
  f.models.setProvider(
    createProvider({
      id: "fake",
      name: "Fake Provider",
      auth: { apiKey: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]) },
      models: [
        fakeModel("fake", "fake-small", { reasoning: false, input: ["text"], contextWindow: 100, maxTokens: 10 }),
        fakeModel("fake", "fake-large"),
      ],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "listModels");
  assert.deepEqual(res.result, {
    models: [
      {
        provider: "fake",
        id: "fake-small",
        name: "Fake fake-small",
        reasoning: false,
        input: ["text"],
        contextWindow: 100,
        maxTokens: 10,
      },
      {
        provider: "fake",
        id: "fake-large",
        name: "Fake fake-large",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
});

test("listModels aggregates models across providers", async (t) => {
  const f = fixture(t);
  for (const id of ["p1", "p2"]) {
    f.models.setProvider(
      createProvider({
        id,
        auth: { apiKey: envApiKeyAuth(`${id} key`, ["NOPE"]) },
        models: [fakeModel(id, `${id}-model`)],
        api: neverStream,
      }),
    );
  }
  const c = await connect(t, f);
  const res = await c.request(2, "listModels");
  assert.deepEqual(
    res.result.models.map((m: any) => [m.provider, m.id]),
    [
      ["p1", "p1-model"],
      ["p2", "p2-model"],
    ],
  );
});

// --- authStatus --------------------------------------------------------------

test("authStatus: env-var-configured provider reports configured with the var as source", async (t) => {
  const f = fixture(t, { FAKE_API_KEY: "sk-live" });
  f.models.setProvider(
    createProvider({
      id: "fake",
      name: "Fake Provider",
      auth: { apiKey: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]) },
      models: [fakeModel("fake", "fake-large")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  assert.deepEqual(res.result, {
    providers: [{ provider: "fake", name: "Fake Provider", methods: ["api_key"], configured: true, source: "FAKE_API_KEY" }],
  });
});

// inference.md: optional fields are omitted when absent (never null) — an
// unconfigured provider has no source key at all
test("authStatus: unconfigured provider is configured:false with source omitted", async (t) => {
  const f = fixture(t); // env empty
  f.models.setProvider(
    createProvider({
      id: "fake",
      name: "Fake Provider",
      auth: { apiKey: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]) },
      models: [fakeModel("fake", "fake-large")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  assert.deepEqual(res.result, {
    providers: [{ provider: "fake", name: "Fake Provider", methods: ["api_key"], configured: false }],
  });
});

test("authStatus: a stored api_key credential wins and is labeled as such", async (t) => {
  const f = fixture(t, { FAKE_API_KEY: "sk-env" }); // stored credential owns the provider
  await f.store.modify("fake", async () => ({ type: "api_key", key: "sk-stored" }));
  f.models.setProvider(
    createProvider({
      id: "fake",
      auth: { apiKey: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]) },
      models: [fakeModel("fake", "fake-large")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  const p = res.result.providers[0];
  assert.equal(p.configured, true);
  assert.equal(p.source, "stored credential");
});

// authStatus must not make network calls: an EXPIRED stored OAuth credential
// still reports configured, and refresh is never invoked
test("authStatus: stored oauth reports configured without triggering a refresh", async (t) => {
  const f = fixture(t);
  const refreshCalls: unknown[] = [];
  await f.store.modify("fake", async () => ({ type: "oauth", access: "at", refresh: "rt", expires: 1 })); // long expired
  f.models.setProvider(
    createProvider({
      id: "fake",
      name: "Fake Provider",
      auth: {
        apiKey: envApiKeyAuth("Fake API key", ["FAKE_API_KEY"]),
        oauth: recordingOAuth(refreshCalls),
      },
      models: [fakeModel("fake", "fake-large")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  assert.deepEqual(res.result, {
    providers: [
      { provider: "fake", name: "Fake Provider", methods: ["api_key", "oauth"], configured: true, source: "OAuth" },
    ],
  });
  assert.deepEqual(refreshCalls, [], "authStatus must not trigger an OAuth refresh");
});

test("authStatus: methods reflect which auth surfaces the provider offers", async (t) => {
  const f = fixture(t);
  const refreshCalls: unknown[] = [];
  f.models.setProvider(
    createProvider({
      id: "keyed",
      auth: { apiKey: envApiKeyAuth("k", ["K"]) },
      models: [fakeModel("keyed", "m")],
      api: neverStream,
    }),
  );
  f.models.setProvider(
    createProvider({
      id: "oauthed",
      auth: { oauth: recordingOAuth(refreshCalls) },
      models: [fakeModel("oauthed", "m")],
      api: neverStream,
    }),
  );
  f.models.setProvider(
    createProvider({
      id: "both",
      auth: { apiKey: envApiKeyAuth("k", ["K"]), oauth: recordingOAuth(refreshCalls) },
      models: [fakeModel("both", "m")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  const byId = Object.fromEntries(res.result.providers.map((p: any) => [p.provider, p.methods]));
  assert.deepEqual(byId, { keyed: ["api_key"], oauthed: ["oauth"], both: ["api_key", "oauth"] });
  // an oauth-only provider with nothing stored is unconfigured (nothing to
  // resolve by presence, no api_key surface to consult ambient env)
  const oauthed = res.result.providers.find((p: any) => p.provider === "oauthed");
  assert.deepEqual({ configured: oauthed.configured, source: oauthed.source }, { configured: false, source: undefined });
});

// pi-ai's resolveProviderAuth treats a stored credential with no matching
// handler as unconfigured, with NO env fallback — a hand-edited auth.json
// with a bogus type tag must not report configured:true while respond fails
test("authStatus: stored credential with unrecognized type is configured:false", async (t) => {
  const f = fixture(t);
  // write the bogus-typed credential through the store (as a hand-edit would
  // land on disk); the cast bypasses the Credential union deliberately
  await f.store.modify("fake", async () => ({ type: "bearer", key: "x" }) as any);
  f.models.setProvider(
    createProvider({
      id: "fake",
      name: "Fake Provider",
      auth: { apiKey: envApiKeyAuth("k", ["PINO_TEST_FAKE_KEY"]) },
      models: [fakeModel("fake", "m")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  assert.deepEqual(res.result.providers, [
    { provider: "fake", name: "Fake Provider", methods: ["api_key"], configured: false },
  ]);
});

// "must not throw when a provider is unconfigured": a resolve() failure on
// one provider degrades to configured:false and leaves the rest intact
test("authStatus: a provider whose resolve throws reports configured:false", async (t) => {
  const f = fixture(t, { GOOD_KEY: "sk" });
  f.models.setProvider(
    createProvider({
      id: "broken",
      auth: {
        apiKey: {
          name: "Broken key",
          resolve: async () => {
            throw new Error("resolver exploded");
          },
        },
      },
      models: [fakeModel("broken", "m")],
      api: neverStream,
    }),
  );
  f.models.setProvider(
    createProvider({
      id: "good",
      auth: { apiKey: envApiKeyAuth("Good key", ["GOOD_KEY"]) },
      models: [fakeModel("good", "m")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  const byId = Object.fromEntries(res.result.providers.map((p: any) => [p.provider, p]));
  assert.equal(byId.broken.configured, false);
  assert.equal(byId.good.configured, true);
});

// a dynamic provider before its first refresh has no model to resolve
// against; a stored credential still counts, ambient cannot be checked
test("authStatus: provider with no models falls back to stored-credential presence", async (t) => {
  const f = fixture(t, { EMPTY_KEY: "sk-env" });
  f.models.setProvider(
    createProvider({
      id: "empty-stored",
      auth: { apiKey: envApiKeyAuth("k", ["EMPTY_KEY"]) },
      models: [],
      api: neverStream,
    }),
  );
  f.models.setProvider(
    createProvider({
      id: "empty-bare",
      auth: { apiKey: envApiKeyAuth("k", ["UNSET_VAR"]) },
      models: [],
      api: neverStream,
    }),
  );
  await f.store.modify("empty-stored", async () => ({ type: "api_key", key: "sk-stored" }));
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  const byId = Object.fromEntries(res.result.providers.map((p: any) => [p.provider, p]));
  assert.equal(byId["empty-stored"].configured, true);
  assert.equal(byId["empty-bare"].configured, false);
});

// authStatus resolves ~35 real providers per call; reading + parsing
// auth.json once per provider is wasteful. The whole file is snapshotted once
// and threaded to every provider's status — same results, one read.
test("authStatus: reads the credentials file once per call, not once per provider", async (t) => {
  const stateDir = tmpDir(t, "pino-methods-readonce-");
  let reads = 0;
  let readAlls = 0;
  class CountingStore extends FileCredentialStore {
    async read(id: string) {
      reads++;
      return super.read(id);
    }
    readAll() {
      readAlls++;
      return super.readAll();
    }
  }
  const store = new CountingStore(stateDir);
  const models = createModels({ credentials: store });
  for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
    models.setProvider(
      createProvider({
        id,
        auth: { apiKey: envApiKeyAuth("k", ["NOPE"]) },
        models: [fakeModel(id, `${id}-m`)],
        api: neverStream,
      }),
    );
  }
  const handler = makeAuthStatus(models, store, fakeAuthContext({}));
  const res = (await handler(undefined, undefined as any, undefined as any)) as { providers: unknown[] };
  assert.equal(res.providers.length, 5);
  assert.equal(readAlls, 1, "auth.json parsed exactly once for the whole call");
  assert.equal(reads, 0, "no per-provider reads");
});

// mirrors pi-ai resolveProviderAuth: a stored credential owns the provider;
// a credential type with no matching handler is unconfigured, no env fallback
test("authStatus: stored oauth credential for an api_key-only provider is unconfigured", async (t) => {
  const f = fixture(t, { LONELY_KEY: "sk-env" });
  await f.store.modify("lonely", async () => ({ type: "oauth", access: "at", refresh: "rt", expires: 1 }));
  f.models.setProvider(
    createProvider({
      id: "lonely",
      auth: { apiKey: envApiKeyAuth("k", ["LONELY_KEY"]) },
      models: [fakeModel("lonely", "m")],
      api: neverStream,
    }),
  );
  const c = await connect(t, f);
  const res = await c.request(2, "authStatus");
  assert.equal(res.result.providers[0].configured, false);
});
