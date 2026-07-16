import fs from "node:fs";
import path from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

/** gateway.md storage: auth.json is "credentials, keyed by provider id, one
 * type-tagged credential per provider" (pi-ai's `Credential` shape). */
type AuthFile = Record<string, Credential>;

/**
 * pi-ai `CredentialStore` backed by `$PINO_STATE_DIR/gateway/auth.json`.
 * gateway.md: the gateway is the file's only writer — write serialization is
 * in-process only, licensed by the singleton rule; no cross-process locking.
 */
export class FileCredentialStore implements CredentialStore {
  #dir: string;
  #file: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.#dir = path.join(stateDir, "gateway");
    this.#file = path.join(this.#dir, "auth.json");
  }

  /** Whole-file read; a missing file is an empty store. A corrupt file is
   * surfaced as a clear error and never overwritten — modify/delete refuse
   * to write over credentials they cannot read. */
  #load(): AuthFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`corrupt credentials file ${this.#file}: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`corrupt credentials file ${this.#file}: expected a JSON object keyed by provider id`);
    }
    return parsed as AuthFile;
  }

  /** gateway.md: file mode 0600 in a 0700 directory, created on demand. The
   * chmod calls back the mkdir/write modes up: creation modes are masked by
   * the umask and skipped entirely when the path already exists. */
  #store(data: AuthFile): void {
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.#dir, 0o700);
    const tmp = this.#file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    // same-dir rename: a process crash mid-write never truncates auth.json.
    // No fsync — power loss could still yield an empty file on some
    // filesystems; accepted, since re-login recovers and fsync-per-write
    // isn't worth it for this file.
    fs.renameSync(tmp, this.#file);
  }

  /** One chain for ALL mutations — deliberately stricter than pi-ai's
   * per-provider chains: every mutation here is a whole-file
   * read-modify-write, so two providers' interleaved writes would lose one. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#chain;
    const next = (async () => {
      await previous.catch(() => {});
      return task();
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.#load()[providerId];
  }

  /** Whole-file snapshot for callers that consult every provider in one pass
   * (authStatus), so auth.json is read and parsed once per call instead of
   * once per provider. Same semantics as read(): missing file → empty store,
   * corrupt file → throws. */
  readAll(): AuthFile {
    return this.#load();
  }

  /** Stored-credential secret strings (api keys, OAuth access/refresh
   * tokens, provider env values) across all providers — extra redaction
   * targets for `redactSecrets`, since these never appear in process.env
   * (gateway.md: "known secret patterns redacted"). Best-effort log hygiene:
   * an unreadable file yields no extras rather than failing the caller. */
  secretValues(): string[] {
    let data: AuthFile;
    try {
      data = this.#load();
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const credential of Object.values(data)) {
      if (credential === null || typeof credential !== "object") continue;
      const c = credential as Record<string, unknown>;
      for (const v of [c.key, c.access, c.refresh]) if (typeof v === "string") out.push(v);
      if (c.env !== null && typeof c.env === "object") {
        for (const v of Object.values(c.env)) if (typeof v === "string") out.push(v);
      }
    }
    return out;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#enqueue(async () => {
      const data = this.#load();
      const current = data[providerId];
      const next = await fn(current);
      // CredentialStore contract: undefined leaves the entry unchanged;
      // resolve with the post-write credential
      if (next !== undefined) {
        data[providerId] = next;
        this.#store(data);
      }
      return next ?? current;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#enqueue(async () => {
      const data = this.#load();
      if (providerId in data) {
        delete data[providerId];
        this.#store(data);
      }
    });
  }
}
