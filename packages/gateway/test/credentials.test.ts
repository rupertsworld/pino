import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../src/storage/credentials.ts";

function tmpStateDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pino-cred-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const key = (k: string): Credential => ({ type: "api_key", key: k });

test("read of a missing provider resolves undefined, creating nothing", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  assert.equal(await store.read("anthropic"), undefined);
  assert.ok(!fs.existsSync(path.join(stateDir, "gateway")), "read must not create state");
});

test("modify persists a credential and read round-trips it", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  const written = await store.modify("anthropic", async () => key("sk-1"));
  assert.deepEqual(written, key("sk-1"));
  assert.deepEqual(await store.read("anthropic"), key("sk-1"));
});

// gateway.md: "gateway/auth.json is written with file mode 0600 in its 0700
// directory"
test("auth.json is mode 0600 inside a 0700 gateway directory", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  await store.modify("anthropic", async () => key("sk-1"));
  const dir = path.join(stateDir, "gateway");
  const file = path.join(dir, "auth.json");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// gateway.md storage: "credentials, keyed by provider id, one type-tagged
// credential per provider" — the on-disk document is exactly that object.
test("on disk: a top-level object keyed by provider id with type-tagged values", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  await store.modify("anthropic", async () => key("sk-1"));
  await store.modify("openai", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 99 }) as Credential);
  const doc = JSON.parse(fs.readFileSync(path.join(stateDir, "gateway", "auth.json"), "utf8"));
  assert.deepEqual(doc, {
    anthropic: { type: "api_key", key: "sk-1" },
    openai: { type: "oauth", access: "a", refresh: "r", expires: 99 },
  });
});

test("modify sees the current credential; returning undefined leaves it unchanged", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  await store.modify("anthropic", async () => key("sk-1"));
  const seen: (Credential | undefined)[] = [];
  const result = await store.modify("anthropic", async (current) => {
    seen.push(current);
    return undefined;
  });
  assert.deepEqual(seen, [key("sk-1")]);
  // CredentialStore contract: resolves with the post-write credential
  assert.deepEqual(result, key("sk-1"));
  assert.deepEqual(await store.read("anthropic"), key("sk-1"));
});

test("delete removes only that provider's credential; deleting a missing one is a no-op", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  await store.modify("anthropic", async () => key("sk-1"));
  await store.modify("openai", async () => key("sk-2"));
  await store.delete("anthropic");
  assert.equal(await store.read("anthropic"), undefined);
  assert.deepEqual(await store.read("openai"), key("sk-2"));
  await store.delete("never-stored"); // must not throw
});

test("credentials persist across store instances (same file)", async (t) => {
  const stateDir = tmpStateDir(t);
  await new FileCredentialStore(stateDir).modify("anthropic", async () => key("sk-1"));
  assert.deepEqual(await new FileCredentialStore(stateDir).read("anthropic"), key("sk-1"));
});

// gateway.md: "writes serialize in-process" — interleaved modifies (each
// with an await inside its fn, holding the read-modify-write open) must not
// lose updates.
test("concurrent modifies of one provider serialize without lost updates", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  const N = 25;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.modify("anthropic", async (current) => {
        const prev = current?.type === "api_key" ? (current.key ?? "") : "";
        await new Promise((r) => setTimeout(r, (N - i) % 3)); // widen the interleaving window
        return { type: "api_key", key: prev + "x" };
      }),
    ),
  );
  const final = await store.read("anthropic");
  assert.equal(final?.type === "api_key" ? final.key : "", "x".repeat(N));
});

// the file is a single document: concurrent modifies of DIFFERENT providers
// must not clobber each other's whole-file writes either
test("concurrent modifies of different providers both persist", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  await Promise.all([
    store.modify("anthropic", async () => {
      await new Promise((r) => setTimeout(r, 2));
      return key("sk-a");
    }),
    store.modify("openai", async () => key("sk-b")),
    store.delete("never-stored"),
  ]);
  assert.deepEqual(await store.read("anthropic"), key("sk-a"));
  assert.deepEqual(await store.read("openai"), key("sk-b"));
});

// conservative corrupt-file behavior: surface a clear error naming the file;
// never silently clobber what might be someone's credentials
test("a corrupt auth.json is surfaced as an error and never overwritten", async (t) => {
  const stateDir = tmpStateDir(t);
  const dir = path.join(stateDir, "gateway");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(file, "{not json", { mode: 0o600 });

  const store = new FileCredentialStore(stateDir);
  await assert.rejects(store.read("anthropic"), /auth\.json/);
  await assert.rejects(store.modify("anthropic", async () => key("sk-1")), /auth\.json/);
  await assert.rejects(store.delete("anthropic"), /auth\.json/);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json", "corrupt file left untouched");
});

test("a non-object auth.json document is rejected, not clobbered", async (t) => {
  const stateDir = tmpStateDir(t);
  const dir = path.join(stateDir, "gateway");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(file, "[1,2,3]", { mode: 0o600 });
  const store = new FileCredentialStore(stateDir);
  await assert.rejects(store.modify("anthropic", async () => key("sk-1")), /auth\.json/);
  assert.equal(fs.readFileSync(file, "utf8"), "[1,2,3]");
});

// a rejection from fn propagates and writes nothing (CredentialStore contract)
test("a modify whose fn rejects writes nothing and does not wedge the queue", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  await assert.rejects(
    store.modify("anthropic", async () => {
      throw new Error("login aborted");
    }),
    /login aborted/,
  );
  assert.equal(await store.read("anthropic"), undefined);
  // the serialization chain survives the rejection
  await store.modify("anthropic", async () => key("sk-after"));
  assert.deepEqual(await store.read("anthropic"), key("sk-after"));
});

// gateway.md mode rules must hold for PRE-EXISTING loose-mode paths too —
// creation-time modes are umask-masked and skipped entirely for paths that
// already exist, so the chmod backstops are load-bearing
test("pre-existing loose-mode dir/file/tmp are corrected to 0700/0600", async (t) => {
  const stateDir = tmpStateDir(t);
  const dir = path.join(stateDir, "gateway");
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(dir, "auth.json"), "{}\n", { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "auth.json.tmp"), "junk", { mode: 0o644 });
  const store = new FileCredentialStore(stateDir);
  await store.modify("anthropic", async () => key("sk-1"));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "auth.json")).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(dir, "auth.json.tmp")), "leftover tmp consumed");
});

test("modify returning undefined on a never-stored provider creates no state", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  const result = await store.modify("anthropic", async () => undefined);
  assert.equal(result, undefined);
  assert.ok(!fs.existsSync(path.join(stateDir, "gateway", "auth.json")), "no file written");
});

// slice C redaction carry-over: stored-credential values are secrets not in
// env; secretValues() feeds them to redactSecrets as extra targets. It is a
// log-hygiene helper — best-effort, never throwing.
test("secretValues collects key/access/refresh/env values across providers", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  assert.deepEqual(store.secretValues(), [], "empty store yields no secrets");
  await store.modify("keyed", async () => ({ type: "api_key", key: "sk-stored-key-1", env: { ACCOUNT_TOKEN: "cf-account-value" } }));
  await store.modify("oauthed", async () => ({ type: "oauth", access: "gho_accesstoken", refresh: "ya29.refreshtoken", expires: 1 }));
  assert.deepEqual(store.secretValues().sort(), [
    "cf-account-value",
    "gho_accesstoken",
    "sk-stored-key-1",
    "ya29.refreshtoken",
  ]);
});

test("secretValues on a corrupt or missing file is empty, never a throw", async (t) => {
  const stateDir = tmpStateDir(t);
  const store = new FileCredentialStore(stateDir);
  assert.deepEqual(store.secretValues(), []);
  const dir = path.join(stateDir, "gateway");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), "not json");
  assert.deepEqual(store.secretValues(), [], "corrupt file degrades to no extra secrets");
});
