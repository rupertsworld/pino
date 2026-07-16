import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockSync } from "proper-lockfile";

/** storage.md: PINO_STATE_DIR is the root of all state; default ~/.pino. */
export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.PINO_STATE_DIR || path.join(os.homedir(), ".pino");
}

/** storage.md: "run/ is created with mode 0700" — sockets inside an
 * untraversable directory are the wire's entire access-control story. */
export function prepareRunDir(stateDir: string): string {
  const runDir = path.join(stateDir, "run");
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runDir, 0o700); // mkdir mode is masked by umask and skipped when the dir exists
  return runDir;
}

/** Thrown when a live gateway already holds the singleton name. `pid` is
 * informational when known (read from the incumbent descriptor); the lock,
 * not the pid, is what refused us. */
export class SingletonError extends Error {
  constructor(pid?: number) {
    super(pid === undefined ? "a gateway is already running" : `a gateway is already running (pid ${pid})`);
    this.name = "SingletonError";
  }
}

/** How long an unrefreshed lock lives before it is considered abandoned. A
 * live holder refreshes its lockfile mtime every `STALE_MS/2`; a crashed
 * holder stops, and after this window proper-lockfile reclaims the lock for
 * the next claimer. This is the one behavioral tradeoff of the lock: crash
 * recovery is not instant but bounded to a few seconds. */
const STALE_MS = 5000;

/** storage.md ^storage-singleton: claim the gateway's singleton name with a
 * proper advisory lock (proper-lockfile), acquired BEFORE any socket bind.
 * The lock is the sole mutual-exclusion mechanism: a live holder makes any
 * second start refuse (ELOCKED → SingletonError); a crashed holder's lock
 * goes stale by mtime and is reclaimed automatically — no pid-based
 * stale-descriptor reclaim to race. Holding the lock means no live
 * predecessor exists, so it is safe to overwrite the descriptor and remove a
 * crashed predecessor's leftover socket before the caller binds. The lock is
 * held for the process lifetime; `release` frees it on clean shutdown. */
export function claimGatewaySingleton(runDir: string): {
  descriptorPath: string;
  socketPath: string;
  release: () => void;
} {
  const descriptorPath = path.join(runDir, "gateway.json");
  const socketPath = path.join(runDir, "gateway.sock");

  let release: () => void;
  try {
    // realpath:false — the descriptor need not exist yet; the lock is on the
    // name. proper-lockfile owns staleness: a fresh (refreshed) lock throws
    // ELOCKED, a stale one is reclaimed here.
    release = lockSync(descriptorPath, { realpath: false, stale: STALE_MS });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOCKED") throw new SingletonError();
    throw err;
  }

  // We hold the singleton. The descriptor's pid is now informational
  // (discovery/debugging), not the liveness mechanism.
  const descriptor = {
    transport: "unix",
    path: socketPath,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor) + "\n");
  // Any socket beside the descriptor predates our claim — the lock guarantees
  // no live predecessor, so it is crash leavings, safe to sweep. Sockets live
  // in run/ (storage.md ^storage-sweep-scope): we construct the conventional
  // path and never follow a descriptor-supplied `path`.
  fs.rmSync(socketPath, { force: true });

  return { descriptorPath, socketPath, release };
}
