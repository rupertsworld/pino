import {
  type Api,
  type AuthContext,
  type Credential,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../src/storage/credentials.ts";

// The generic wire/test surface (NDJSON Client, server bootstrap, the
// initialize handshake, timing/fs fixtures) lives in the transport package and
// is shared across components. Re-exported here so gateway suites keep a single
// `./helpers.ts` import; the gateway-specific pi-ai fixtures are added below.
export {
  Client,
  SERVER_INFO,
  connectClient,
  deadPid,
  initHandler,
  initParams,
  onAbort,
  startWireServer,
  tmpDir,
  withTimeout,
} from "@pino-agent/transport/test-helpers";

// --- provider / model fixtures ----------------------------------------------

/** A minimal `Model` shaped like the real catalog; `overrides` tweak any field
 * a test cares about (input, reasoning, contextWindow, …). */
export function fakeModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: `Fake ${id}`,
    api: "anthropic-messages",
    provider,
    baseUrl: "http://localhost:0",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
    ...overrides,
  };
}

/** A ProviderStreams that throws if streamed — present only because
 * createProvider requires it for providers that are never asked to respond. */
export const neverStream: ProviderStreams = {
  stream: () => {
    throw new Error("stream must not be called");
  },
  streamSimple: () => {
    throw new Error("streamSimple must not be called");
  },
};

/** An AuthContext backed by an in-memory env map, never touching the real
 * process env or filesystem. */
export function fakeAuthContext(env: Record<string, string> = {}): AuthContext {
  return {
    env: async (name) => env[name],
    fileExists: async () => false,
  };
}

/** A real FileCredentialStore that counts persists — a write observer letting
 * suites assert "wrote exactly once" / "never wrote" deterministically instead
 * of sampling after a sleep. A modify persists iff its fn returns a credential;
 * a delete persists iff the key existed, so each counter increments at the
 * point disk is actually touched. */
export class ObservableCredentialStore extends FileCredentialStore {
  writes = 0;
  modifyCalls = 0;
  deletes = 0;
  #waiters: { n: number; resolve: () => void }[] = [];
  override modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    // increment synchronously, on entry — before the serialized chain — so a
    // barrier can observe that a request has reached the modify queue
    this.modifyCalls++;
    this.#waiters = this.#waiters.filter((w) => {
      if (this.modifyCalls >= w.n) {
        w.resolve();
        return false;
      }
      return true;
    });
    return super.modify(providerId, async (current) => {
      const next = await fn(current);
      if (next !== undefined) this.writes++;
      return next;
    });
  }
  /** Resolves once `modifyCalls` has reached `n` — a deterministic barrier for
   * "both concurrent requests have entered the serialized modify queue". */
  waitForModifyCalls(n: number): Promise<void> {
    if (this.modifyCalls >= n) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ n, resolve }));
  }
}
