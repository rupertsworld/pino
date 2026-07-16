import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client, deadPid, initParams, tmpDir } from "./helpers.ts";

const pkgDir = path.resolve(import.meta.dirname, "..");
const entry = path.join(pkgDir, "src", "index.ts");

function tmpStateDir(t: TestContext): string {
  return tmpDir(t, "pino-life-");
}

function startGateway(t: TestContext, stateDir: string): { child: ChildProcess; stderr: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: { ...process.env, PINO_STATE_DIR: stateDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(() => {
    child.kill("SIGKILL");
  });
  return { child, stderr: () => stderr, exited };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// storage.md: "A serving process writes its descriptor on startup and
// removes it (and its socket) on clean shutdown."
test("gateway writes descriptor on start, serves initialize, removes it on SIGTERM", async (t) => {
  const stateDir = tmpStateDir(t);
  const { child, stderr, exited } = startGateway(t, stateDir);
  const descriptorPath = path.join(stateDir, "run", "gateway.json");
  const socketPath = path.join(stateDir, "run", "gateway.sock");

  await waitFor(() => fs.existsSync(descriptorPath), "descriptor");
  const desc = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  assert.equal(desc.transport, "unix");
  assert.equal(desc.path, socketPath);
  assert.equal(desc.pid, child.pid);
  assert.ok(!Number.isNaN(Date.parse(desc.startedAt)));

  // storage.md: run/ mode 0700
  assert.equal(fs.statSync(path.join(stateDir, "run")).mode & 0o777, 0o700);

  // one startup line on stderr naming the socket path
  await waitFor(() => stderr().includes(socketPath), "startup log line");

  // storage.md ^storage-dial-descriptor: dial what the descriptor says
  const c = new Client(desc.path);
  t.after(() => c.end());
  const reply = await c.request(1, "initialize", initParams());
  assert.equal(reply.result.version, 1);
  assert.equal(reply.result.serverInfo.name, "pino-gateway");

  child.kill("SIGTERM");
  const code = await exited;
  assert.equal(code, 0, "clean shutdown exits 0");
  assert.ok(!fs.existsSync(descriptorPath), "descriptor removed on shutdown");
  assert.ok(!fs.existsSync(socketPath), "socket removed on shutdown");
});

// same lifecycle under SIGINT (only SIGTERM was previously exercised)
test("gateway removes descriptor and socket on SIGINT", async (t) => {
  const stateDir = tmpStateDir(t);
  const { child, exited } = startGateway(t, stateDir);
  const descriptorPath = path.join(stateDir, "run", "gateway.json");
  const socketPath = path.join(stateDir, "run", "gateway.sock");
  await waitFor(() => fs.existsSync(descriptorPath) && fs.existsSync(socketPath), "descriptor and socket");
  assert.equal(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).pid, child.pid);
  child.kill("SIGINT");
  const code = await exited;
  assert.equal(code, 0, "clean shutdown exits 0");
  assert.ok(!fs.existsSync(descriptorPath), "descriptor removed on shutdown");
  assert.ok(!fs.existsSync(socketPath), "socket removed on shutdown");
});

// storage.md ^storage-singleton: a live holder (holding the advisory lock)
// makes any second start refuse. Refusal is lock-based now, not pid-based:
// only a genuinely running gateway holding the lock refuses a second — so this
// stands up a real first gateway rather than planting a descriptor.
test("gateway refuses to start when a live gateway already holds the lock", async (t) => {
  const stateDir = tmpStateDir(t);
  const descriptorPath = path.join(stateDir, "run", "gateway.json");
  const socketPath = path.join(stateDir, "run", "gateway.sock");

  // a real first gateway: it acquires the lock and serves
  const first = startGateway(t, stateDir);
  await waitFor(() => fs.existsSync(descriptorPath) && fs.existsSync(socketPath), "first gateway's descriptor and socket");
  const held = fs.readFileSync(descriptorPath, "utf8");

  // the second refuses against the live holder
  const { stderr, exited } = startGateway(t, stateDir);
  const code = await exited;
  assert.notEqual(code, 0, "refusal is a nonzero exit");
  assert.match(stderr(), /already running/);
  assert.equal(fs.readFileSync(descriptorPath, "utf8"), held, "live holder's descriptor untouched");
  // refusing must never unlink the live gateway's socket
  assert.ok(fs.existsSync(socketPath), "live holder's socket untouched");
  assert.equal(first.child.exitCode, null, "the holder is still running");

  first.child.kill("SIGTERM");
  assert.equal(await first.exited, 0, "holder shuts down cleanly");
});

// storage.md ^storage-singleton: the advisory lock is the atomic claim — of
// two near-simultaneous starts, exactly one wins. Repeated a few rounds to
// widen the sampled interleavings.
test("two near-simultaneous gateways: exactly one wins the claim", async (t) => {
  for (let round = 0; round < 3; round++) {
    const stateDir = tmpStateDir(t);
    const descriptorPath = path.join(stateDir, "run", "gateway.json");
    const a = startGateway(t, stateDir);
    const b = startGateway(t, stateDir);

    // exactly one must exit, refusing the claim, and it must exit nonzero
    const loserName = await Promise.race([
      a.exited.then(() => "a" as const),
      b.exited.then(() => "b" as const),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`round ${round}: neither gateway exited — both claimed the singleton`)), 10000).unref(),
      ),
    ]);
    const loser = loserName === "a" ? a : b;
    const winner = loserName === "a" ? b : a;
    assert.notEqual(await loser.exited, 0, `round ${round}: loser refuses with a nonzero exit`);
    assert.match(loser.stderr(), /already running/, `round ${round}: loser names the refusal`);

    // the winner is alive, owns the descriptor, and is serving
    await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(descriptorPath, "utf8")).pid === winner.child.pid;
      } catch {
        return false;
      }
    }, `round ${round}: winner's descriptor`);
    assert.equal(winner.child.exitCode, null, `round ${round}: winner is still running`);

    winner.child.kill("SIGTERM");
    assert.equal(await winner.exited, 0, `round ${round}: winner shuts down cleanly`);
  }
});

// storage.md ^storage-singleton: a crashed predecessor leaves a descriptor and
// socket behind (its lock already stale/gone). On acquiring the lock the new
// gateway overwrites the leftover descriptor and sweeps the leftover socket.
test("gateway overwrites a crashed predecessor's leftover descriptor and starts", async (t) => {
  const stateDir = tmpStateDir(t);
  const runDir = path.join(stateDir, "run");
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const descriptorPath = path.join(runDir, "gateway.json");
  const socketPath = path.join(runDir, "gateway.sock");
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({ transport: "unix", path: socketPath, pid: deadPid(), startedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(socketPath, ""); // crash leftover

  const { child, exited } = startGateway(t, stateDir);
  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(descriptorPath, "utf8")).pid === child.pid;
    } catch {
      return false;
    }
  }, "descriptor rewritten by the new gateway");
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
});
