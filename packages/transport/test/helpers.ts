import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createWireServer, makeInitialize, type MethodHandler, type ServerInfo } from "../src/index.ts";

// Shared wire test surface — the generic pieces both transport's own tests and
// any component's tests need (NDJSON client, server bootstrap, the initialize
// handshake, timing/fs fixtures). Exported via `@pino-agent/transport/test-helpers`.
// A schema-speaking component's tests re-export these and add their own
// fixtures (fake providers, etc.).

// --- timing utilities --------------------------------------------------------

/** Reject `p` if it does not settle within 5s, naming `what` — turns a hung
 * wait into a legible test failure instead of a timeout kill. */
export function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 5000);
    }),
  ]);
}

/** Resolves when `signal` aborts (immediately if already aborted). */
export function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return withTimeout(
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    "abort signal",
  );
}

// --- filesystem / process fixtures -------------------------------------------

/** mkdtemp under os.tmpdir(), auto-removed when the test ends. */
export function tmpDir(t: TestContext, prefix = "pino-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A pid guaranteed dead: a child process that has already exited. */
export function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

// --- wire handshake ----------------------------------------------------------

// The handshake is schema-agnostic (transport.md: "schema names and version
// numbers are declared by each schema spec, not this document"). A HandshakeFixture
// names the schema, the versions the listener speaks, and the serverInfo it
// echoes, so a suite can prove the handshake works for ANY schema — not only
// inference. The helper functions below accept a fixture; the default is the
// inference fixture, so callers that pass nothing (gateway's suites, which
// re-export these helpers) keep speaking pino.inference at version 1 exactly
// as before.
export interface HandshakeFixture {
  schema: string;
  versions: readonly number[];
  serverInfo: ServerInfo;
}

export const SERVER_INFO = { name: "pino-gateway", version: "0.0.0-test" };

/** The default fixture: the inference schema at version 1. Kept as the default
 * argument of every handshake helper so no existing caller changes behavior. */
export const INFERENCE_HANDSHAKE: HandshakeFixture = {
  schema: "pino.inference",
  versions: [1],
  serverInfo: SERVER_INFO,
};

/** The `initialize` params literal, with optional overrides for handshake
 * tests (unsupported version, wrong schema, unknown fields). The fixture
 * supplies the schema/version; defaults to the inference fixture. */
export function initParams(
  overrides: Record<string, unknown> = {},
  fixture: HandshakeFixture = INFERENCE_HANDSHAKE,
) {
  return {
    schema: fixture.schema,
    version: fixture.versions[0],
    clientInfo: { name: "test", version: "0" },
    ...overrides,
  };
}

/** An initialize handler for the given handshake fixture; defaults to the
 * inference fixture used by gateway's suites. */
export function initHandler(fixture: HandshakeFixture = INFERENCE_HANDSHAKE): MethodHandler {
  return makeInitialize(fixture.schema, fixture.versions, fixture.serverInfo);
}

// --- NDJSON socket client ----------------------------------------------------

/**
 * Predicate-based NDJSON client over a real socket — no transport mocks. Every
 * decoded message is retained in `messages` (and its raw line in `raw`);
 * `waitFor` scans that history so a matcher registered after the message
 * already arrived still resolves. Answers server→client requests
 * (serverRequest/respondTo) for the login flow, and exposes a FIFO `next`
 * cursor plus `expectSilence`/`closed` for the transport-level wire tests.
 */
export class Client {
  socket: net.Socket;
  messages: any[] = [];
  raw: string[] = [];
  closed: Promise<void>;
  #buffer = "";
  #consumed = 0;
  #waiters: { pred: (messages: any[]) => any; resolve: (v: any) => void }[] = [];

  constructor(sockPath: string) {
    this.socket = net.connect(sockPath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const nl = this.#buffer.indexOf("\n");
        if (nl === -1) break;
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        this.raw.push(line);
        this.messages.push(JSON.parse(line));
      }
      for (let i = 0; i < this.#waiters.length; ) {
        const hit = this.#waiters[i].pred(this.messages);
        if (hit !== undefined) {
          const [w] = this.#waiters.splice(i, 1);
          w.resolve(hit);
        } else i++;
      }
    });
    this.closed = new Promise((resolve) => this.socket.on("close", () => resolve()));
  }

  send(m: unknown): void {
    this.socket.write(JSON.stringify(m) + "\n");
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Resolve with the first value `pred` returns non-undefined for, scanning
   * the full message history on every arrival. */
  waitFor<T>(pred: (messages: any[]) => T | undefined, what: string): Promise<T> {
    const hit = pred(this.messages);
    if (hit !== undefined) return Promise.resolve(hit);
    return withTimeout(new Promise<T>((resolve) => this.#waiters.push({ pred, resolve })), what);
  }

  request(id: number, method: string, params?: unknown): Promise<any> {
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return this.response(id);
  }

  /** The response for `id`. The `method` guard distinguishes a response from a
   * server→client request that happens to reuse the same id number (the two
   * id spaces are independent). */
  response(id: number | null): Promise<any> {
    return this.waitFor(
      (ms) => ms.find((m) => m.id === id && typeof m.method !== "string" && ("result" in m || "error" in m)),
      `response ${id}`,
    );
  }

  /** Next inbound server→client request with the given method, skipping ones
   * already answered. */
  serverRequest(method: string, skip = 0): Promise<any> {
    return this.waitFor(
      (ms) => ms.filter((m) => m.method === method && "id" in m)[skip],
      `server request ${method} #${skip}`,
    );
  }

  /** Answer a server→client request. */
  respondTo(id: unknown, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  /** respondEvent payloads received so far for one request id, in order. */
  events(requestId: number): any[] {
    return this.messages
      .filter((m) => m.method === "respondEvent" && m.params?.requestId === requestId)
      .map((m) => m.params.event);
  }

  /** FIFO cursor: the next message not yet returned by `next`, in arrival
   * order and id-agnostic (for transport tests that assert raw ordering). */
  next(): Promise<any> {
    return this.waitFor(
      () => (this.#consumed < this.messages.length ? this.messages[this.#consumed++] : undefined),
      "message",
    );
  }

  /** Asserts no further message arrives within the window. */
  async expectSilence(ms = 150): Promise<void> {
    const before = this.messages.length;
    await new Promise((resolve) => setTimeout(resolve, ms));
    assert.equal(
      this.messages.length,
      before,
      `expected silence, got ${JSON.stringify(this.messages.slice(before))}`,
    );
  }

  end(): void {
    this.socket.destroy();
  }
}

// --- server / client setup ---------------------------------------------------

/** Start a wire server on a throwaway unix socket with the given handler map
 * (the caller supplies `initialize`), auto-closed and the dir removed when the
 * test ends. Returns the socket path. */
export async function startWireServer(
  t: TestContext,
  handlers: Record<string, MethodHandler>,
): Promise<string> {
  const dir = tmpDir(t, "pino-wire-");
  const sockPath = path.join(dir, "gateway.sock");
  const server = createWireServer(handlers);
  await server.listen(sockPath);
  t.after(() => server.close());
  return sockPath;
}

/** Connect a Client, perform the initialize handshake, and return it once the
 * connection is ready. Auto-ended when the test finishes. The fixture supplies
 * the schema/version handshake; defaults to the inference fixture. */
export async function connectClient(
  t: TestContext,
  sockPath: string,
  fixture: HandshakeFixture = INFERENCE_HANDSHAKE,
): Promise<Client> {
  const client = new Client(sockPath);
  t.after(() => client.end());
  const init = await client.request(1, "initialize", initParams({}, fixture));
  assert.equal(init.result.version, fixture.versions[0]);
  return client;
}
