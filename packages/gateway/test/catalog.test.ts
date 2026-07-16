import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { createCatalog } from "../src/catalog.ts";
import { FileCredentialStore } from "../src/storage/credentials.ts";
import { Client, initParams, tmpDir } from "./helpers.ts";

function tmpStateDir(t: TestContext): string {
  return tmpDir(t, "pino-catalog-");
}

// gateway.md catalog: "The v0 implementation adopts pi-ai's stock catalog
// ... wholesale." Static catalogs need no network; this constructs the real
// builtinModels and checks the anthropic slice looks like a model catalog.
test("integration: the real builtin catalog is non-empty and includes anthropic", (t) => {
  const models = createCatalog(new FileCredentialStore(tmpStateDir(t)));
  const all = models.getModels();
  assert.ok(all.length > 0, "catalog is non-empty");
  const anthropic = all.filter((m) => m.provider === "anthropic");
  assert.ok(anthropic.length > 0, "anthropic models present");
  for (const m of anthropic) {
    assert.ok(m.id.length > 0);
    assert.ok(m.name.length > 0);
    assert.equal(typeof m.reasoning, "boolean");
    assert.ok(m.input.includes("text"));
    assert.ok(m.contextWindow > 0);
    assert.ok(m.maxTokens > 0);
  }
});

// gateway.md catalog: "adopts pi-ai's stock catalog and auth resolution
// wholesale." Assert exactly that by identity, not vibes: the gateway catalog's
// provider set, per-provider model set, and per-provider auth surface must
// equal pi-ai's independently-built stock catalog. Deleting a provider or
// model, filtering the catalog, or stripping an auth method would fail this.
// Compares ids and auth-method presence only — never volatile display text.
test("integration: the catalog is pi-ai's stock catalog exactly (providers, models, auth surface)", (t) => {
  const catalog = createCatalog(new FileCredentialStore(tmpStateDir(t)));

  // provider identity + cardinality against the generated stock table
  const gotProviders = catalog.getProviders().map((p) => p.id).sort();
  const wantProviders = getBuiltinProviders().slice().sort();
  assert.deepEqual(gotProviders, wantProviders, "provider set matches pi-ai's stock catalog");

  // per-provider model identity + cardinality against the generated table
  for (const id of wantProviders) {
    const got = catalog.getModels(id).map((m) => m.id).sort();
    const want = getBuiltinModels(id as Parameters<typeof getBuiltinModels>[0]).map((m) => m.id).sort();
    assert.deepEqual(got, want, `model set for ${id} matches pi-ai's stock catalog`);
  }

  // per-provider auth surface (which methods resolve) against freshly-built
  // stock providers — mutating auth resolution would diverge here
  const stockAuth = new Map(
    builtinProviders().map((p) => [p.id, { apiKey: p.auth.apiKey !== undefined, oauth: p.auth.oauth !== undefined }]),
  );
  for (const provider of catalog.getProviders()) {
    assert.deepEqual(
      { apiKey: provider.auth.apiKey !== undefined, oauth: provider.auth.oauth !== undefined },
      stockAuth.get(provider.id),
      `auth surface for ${provider.id} matches pi-ai's stock provider`,
    );
  }
});

// e2e: the real gateway process serves listModels and authStatus over its
// socket. Spawned with a scrubbed env so ambient keys on the test machine
// cannot make the assertions flaky; shapes only, values are catalog data.
test("e2e: gateway serves listModels and authStatus over the socket", async (t) => {
  const stateDir = tmpStateDir(t);
  const entry = path.join(path.resolve(import.meta.dirname, ".."), "src", "index.ts");
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: { PATH: process.env.PATH, HOME: stateDir, PINO_STATE_DIR: stateDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));

  const socketPath = path.join(stateDir, "run", "gateway.sock");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(socketPath)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for gateway socket");
    await new Promise((r) => setTimeout(r, 25));
  }

  const c = new Client(socketPath);
  t.after(() => c.end());

  const init = await c.request(1, "initialize", initParams());
  assert.equal(init.result.version, 1);

  const list = await c.request(2, "listModels");
  assert.ok(list.result.models.length > 0);
  const anthropic = list.result.models.find((m: any) => m.provider === "anthropic");
  assert.ok(anthropic, "anthropic model on the wire");
  // inference.md: exactly the spec'd subset, nothing else
  assert.deepEqual(
    Object.keys(anthropic).sort(),
    ["contextWindow", "id", "input", "maxTokens", "name", "provider", "reasoning"],
  );

  const status = await c.request(3, "authStatus");
  assert.ok(status.result.providers.length > 0);
  for (const p of status.result.providers) {
    assert.equal(typeof p.provider, "string");
    assert.equal(typeof p.name, "string");
    assert.ok(Array.isArray(p.methods) && p.methods.length > 0, `${p.provider} has at least one auth method`);
    assert.ok(p.methods.every((m: string) => m === "api_key" || m === "oauth"));
    assert.equal(typeof p.configured, "boolean");
    if ("source" in p) assert.equal(typeof p.source, "string");
  }
  const anthStatus = status.result.providers.find((p: any) => p.provider === "anthropic");
  assert.deepEqual(anthStatus?.methods, ["api_key", "oauth"]);
  // scrubbed env, empty state dir: nothing can be configured for anthropic
  assert.equal(anthStatus?.configured, false);

  // unknown methods still answer -32601 after the new handlers are wired
  const unknown = await c.request(4, "definitelyNotAMethod");
  assert.equal(unknown.error.code, -32601);
});
