import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveStateDir,
  prepareRunDir,
  claimGatewaySingleton,
  SingletonError,
} from "../src/run.ts";

/** A pid guaranteed dead: a child process that has already exited. (Inlined so
 * the storage package's tests stay self-contained — no cross-package dep.) */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

function tmpStateDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pino-storage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state"); // not yet created — exercises creation
}

// storage.md: "PINO_STATE_DIR is the root of all persistent and runtime
// state. Default: ~/.pino."
test("resolveStateDir honors PINO_STATE_DIR and defaults to ~/.pino", () => {
  assert.equal(resolveStateDir({ PINO_STATE_DIR: "/some/where" }), "/some/where");
  assert.equal(resolveStateDir({}), path.join(os.homedir(), ".pino"));
});

// storage.md: "run/ is created with mode 0700"
test("prepareRunDir creates state dir and run/ with mode 0700", (t) => {
  const stateDir = tmpStateDir(t);
  const runDir = prepareRunDir(stateDir);
  assert.equal(runDir, path.join(stateDir, "run"));
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
  assert.ok(fs.statSync(stateDir).isDirectory());
});

test("prepareRunDir is idempotent and restores 0700", (t) => {
  const stateDir = tmpStateDir(t);
  const runDir = prepareRunDir(stateDir);
  fs.chmodSync(runDir, 0o755);
  assert.equal(prepareRunDir(stateDir), runDir);
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
});

test("claim with no existing descriptor returns the conventional paths and a release", (t) => {
  const runDir = prepareRunDir(tmpStateDir(t));
  const { descriptorPath, socketPath, release } = claimGatewaySingleton(runDir);
  t.after(() => release());
  assert.equal(descriptorPath, path.join(runDir, "gateway.json"));
  assert.equal(socketPath, path.join(runDir, "gateway.sock"));
  assert.equal(typeof release, "function");
});

// storage.md ^storage-singleton + descriptor shape {transport, path, pid,
// startedAt}: on acquiring the lock the claim writes this process's descriptor.
// The pid is informational (discovery/debugging), not the liveness mechanism.
test("claim writes this process's descriptor on acquiring the lock", (t) => {
  const runDir = prepareRunDir(tmpStateDir(t));
  const { descriptorPath, socketPath, release } = claimGatewaySingleton(runDir);
  t.after(() => release());
  const desc = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  assert.equal(desc.transport, "unix");
  assert.equal(desc.path, socketPath);
  assert.equal(desc.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(desc.startedAt)), "startedAt is a parseable timestamp");
});

// storage.md ^storage-singleton: a live holder (fresh lock) makes any second
// start refuse (ELOCKED → SingletonError). The refusing loser throws before
// writing anything, so it touches neither the holder's descriptor nor socket.
test("a second claim while the lock is held refuses and touches nothing", (t) => {
  const runDir = prepareRunDir(tmpStateDir(t));
  const { descriptorPath, socketPath, release } = claimGatewaySingleton(runDir); // holder
  t.after(() => release());
  fs.writeFileSync(socketPath, "holder's socket"); // stand in for the bound socket
  const held = fs.readFileSync(descriptorPath, "utf8");
  assert.throws(() => claimGatewaySingleton(runDir), SingletonError);
  assert.equal(fs.readFileSync(descriptorPath, "utf8"), held, "loser left the holder's descriptor untouched");
  assert.equal(fs.readFileSync(socketPath, "utf8"), "holder's socket", "loser left the holder's socket untouched");
});

// storage.md ^storage-singleton: the lock is held for the process lifetime;
// release frees it. A clean release lets a subsequent claim succeed.
test("a clean release lets a subsequent claim succeed", (t) => {
  const runDir = prepareRunDir(tmpStateDir(t));
  const first = claimGatewaySingleton(runDir);
  first.release();
  const second = claimGatewaySingleton(runDir); // must not refuse
  t.after(() => second.release());
  assert.equal(JSON.parse(fs.readFileSync(second.descriptorPath, "utf8")).pid, process.pid);
});

// storage.md ^storage-singleton: a crashed holder's lock goes stale by mtime
// and is reclaimed automatically — no pid-based stale-descriptor reclaim to
// race. Simulated by an old-mtime lock left beside a crashed predecessor's
// descriptor and socket; the reclaimer overwrites the descriptor and sweeps
// the socket.
test("a stale (old-mtime) lock is reclaimed, and the crashed predecessor's leavings are swept", (t) => {
  const runDir = prepareRunDir(tmpStateDir(t));
  const descriptorPath = path.join(runDir, "gateway.json");
  const socketPath = path.join(runDir, "gateway.sock");
  // crashed predecessor's leavings
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({ transport: "unix", path: socketPath, pid: deadPid(), startedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(socketPath, ""); // crash leftover socket
  // its abandoned lock, aged well past the stale window
  const lockDir = descriptorPath + ".lock";
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);

  const { release } = claimGatewaySingleton(runDir); // reclaims the stale lock
  t.after(() => release());
  assert.equal(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).pid, process.pid, "descriptor reclaimed");
  assert.ok(!fs.existsSync(socketPath), "crashed predecessor's socket swept");
});

// storage.md: "a socket file with no descriptor beside it" is crash leavings —
// the claim sweeps the conventional socket when it takes the name.
test("claim removes an orphan socket with no descriptor beside it", (t) => {
  const runDir = prepareRunDir(tmpStateDir(t));
  const socketPath = path.join(runDir, "gateway.sock");
  fs.writeFileSync(socketPath, ""); // crash leftover
  const { release } = claimGatewaySingleton(runDir);
  t.after(() => release());
  assert.ok(!fs.existsSync(socketPath), "orphan socket swept");
});

// storage.md ^storage-sweep-scope: for v0, sockets live in run/ beside their
// descriptor; the claim sweeps only the conventional socket IT constructs
// (`gateway.sock`) and never consults the descriptor's `path` to decide what to
// delete. A leftover descriptor naming some OTHER socket does not get that
// socket swept.
test("claim sweeps only the conventional socket, never a socket the descriptor names", (t) => {
  const runDir = prepareRunDir(tmpStateDir(t));
  const descriptorPath = path.join(runDir, "gateway.json");
  const conventionalSocket = path.join(runDir, "gateway.sock");
  const namedSocket = path.join(runDir, "elsewhere.sock"); // a path the descriptor names
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({ transport: "unix", path: namedSocket, pid: deadPid(), startedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(conventionalSocket, ""); // crash leftover beside the descriptor
  fs.writeFileSync(namedSocket, ""); // named by descriptor.path — must be left alone
  const { release } = claimGatewaySingleton(runDir);
  t.after(() => release());
  assert.ok(!fs.existsSync(conventionalSocket), "the conventional socket beside the descriptor was swept");
  assert.ok(fs.existsSync(namedSocket), "a socket the descriptor merely names is not followed for deletion");
  assert.equal(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).pid, process.pid, "descriptor reclaimed");
});

// storage.md ^storage-sweep-scope (security by construction): the claim never
// consults descriptor.path for deletion, so a leftover or hand-corrupted
// descriptor naming a path OUTSIDE run/ cannot turn the sweep into an
// arbitrary-file delete — the path is simply never read for deletion.
test("claim never deletes a file named by a descriptor's path, even outside runDir", (t) => {
  const stateDir = tmpStateDir(t);
  const runDir = prepareRunDir(stateDir);
  // a bystander file OUTSIDE run/ standing in for any sensitive file an
  // attacker-controlled `path` might name
  const victim = path.join(stateDir, "important-do-not-delete.txt");
  fs.writeFileSync(victim, "precious");
  const descriptorPath = path.join(runDir, "gateway.json");
  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({ transport: "unix", path: victim, pid: deadPid(), startedAt: new Date().toISOString() }),
  );
  const { release } = claimGatewaySingleton(runDir);
  t.after(() => release());
  assert.ok(fs.existsSync(victim), "a path named by the descriptor is never deleted by the claim");
  assert.equal(fs.readFileSync(victim, "utf8"), "precious", "the outside file is untouched");
  assert.equal(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).pid, process.pid, "descriptor still reclaimed");
});

// storage.md ^storage-singleton: the killer property. N real processes claim
// the same run dir simultaneously; the advisory lock guarantees EXACTLY ONE
// acquires and every other refuses with SingletonError — deterministically,
// for any number of claimers (this is what the hand-rolled wx/quarantine dance
// could not guarantee under 3+ simultaneous starts). Run as real subprocesses
// so the interleaving is genuine; asserted on the deterministic end-state so it
// does not flake.
test("N real claimers race one run dir: exactly one wins, the rest refuse", async (t) => {
  const N = 5;
  const runTsUrl = pathToFileURL(path.resolve(import.meta.dirname, "..", "src", "run.ts")).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pino-race-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // a claimer: on winning, linger so its lock stays fresh while the others
  // race; on refusal, exit immediately
  const workerFile = path.join(scratch, "claimer.mjs");
  fs.writeFileSync(
    workerFile,
    `import { claimGatewaySingleton } from ${JSON.stringify(runTsUrl)};\n` +
      `try {\n` +
      `  claimGatewaySingleton(process.argv[2]);\n` +
      `  process.stdout.write("WON " + process.pid + "\\n");\n` +
      `  setTimeout(() => process.exit(0), 1000);\n` + // hold the lock so the win is observable
      `} catch (e) {\n` +
      `  process.stdout.write((e && e.name === "SingletonError" ? "REFUSED" : "ERR " + (e && e.message)) + "\\n");\n` +
      `  process.exit(0);\n` +
      `}\n`,
  );

  function claimer(runDir: string): Promise<{ code: number | null; out: string }> {
    const child = spawn(process.execPath, ["--experimental-strip-types", workerFile, runDir], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    t.after(() => child.kill("SIGKILL"));
    return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out: out.trim() })));
  }

  for (let round = 0; round < 3; round++) {
    const runDir = prepareRunDir(path.join(scratch, `state-${round}`));
    const descriptorPath = path.join(runDir, "gateway.json");

    const results = await Promise.all(Array.from({ length: N }, () => claimer(runDir)));
    const outcomes = results.map((r) => r.out);
    const winners = outcomes.filter((o) => o.startsWith("WON"));
    const refusals = outcomes.filter((o) => o === "REFUSED");
    assert.equal(winners.length, 1, `round ${round}: exactly one claimer wins (got ${JSON.stringify(outcomes)})`);
    assert.equal(refusals.length, N - 1, `round ${round}: the rest refuse (got ${JSON.stringify(outcomes)})`);
    for (const r of results) assert.equal(r.code, 0, `round ${round}: every claimer exits cleanly`);
    // the descriptor bears the winner's pid — no loser clobbered it
    const winnerPid = Number(winners[0].split(" ")[1]);
    assert.equal(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).pid, winnerPid, `round ${round}: descriptor owned by the winner`);
  }
});
