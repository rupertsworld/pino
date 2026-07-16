import { createServer, type Server, type Socket } from "node:net";
import { LineSplitter } from "./framing.ts";

/** A JSON-RPC error a handler may throw to refuse a request. */
export class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export interface Connection {
  /** transport.md direction: either peer may send requests on an open
   * connection; responses match against this side's own outbound ids. */
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /** Fires once when the connection closes (immediately if already closed).
   * transport.md: a dropped connection ends the work in flight on it — a
   * handler with side state (e.g. login) hooks this to tear it down. */
  onClose(listener: () => void): void;
  /** Abort an in-flight inbound request by id — the cancellation surface a
   * `cancel`-style handler uses. No-op if no such request is in flight. The
   * server also aborts every in-flight inbound request when the connection
   * closes. */
  abortInbound(id: unknown): void;
}

/** Per-request context handed to a request handler. `id` is the inbound
 * request id; `signal` aborts when the request is cancelled (via
 * `abortInbound`) or the connection drops. Both are absent when a handler is
 * invoked for a notification (notifications carry no id and own no lifecycle). */
export interface HandlerContext {
  id?: unknown;
  signal?: AbortSignal;
}

export type MethodHandler = (params: unknown, conn: Connection, ctx: HandlerContext) => unknown;

export interface WireServer {
  listen(socketPath: string): Promise<void>;
  close(): Promise<void>;
}

type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void };

/** transport.md handshake: a connection moves uninitialized → initializing →
 * initialized. `initializing` is the window after `initialize` is dispatched
 * but before its handler resolves; `initialized` is committed only on success. */
type ConnState = "uninitialized" | "initializing" | "initialized";

/** transport.md envelope: the request-id domain is a string or a finite number.
 * Any other id (boolean, object, array, null, non-finite number) is not a
 * usable correlation key and makes the request invalid. */
function validId(id: unknown): id is string | number {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

class ServerConnection implements Connection {
  #socket: Socket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  // transport.md: the server owns the inbound-request lifecycle. Each
  // dispatched inbound request gets an AbortController tracked by its id, so
  // `cancel` can abort by id and a connection close aborts every request in
  // flight on it. This map holds only IN-FLIGHT requests (entries are removed
  // on completion by endInbound).
  #inbound = new Map<string | number, AbortController>();
  // inference.md correlation rule: "A caller must not reuse a request id while
  // its connection is open." Enforcement is by connection LIFETIME, not just
  // in-flight: every inbound id ever SEEN on this connection is remembered, so
  // a completed id can never be reused. Reusing a completed id 42 would let a
  // late `cancel{42}` meant for the old request abort a new request 42. The set
  // grows with the connection's request count; acceptable for a v0 same-user
  // socket, and it is dropped when the connection is GC'd (cleared on close).
  #seen = new Set<string | number>();
  #closed = false;
  #closeListeners: (() => void)[] = [];
  state: ConnState = "uninitialized";

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("close", () => {
      for (const p of this.#pending.values()) p.reject(new Error("connection closed"));
      this.#pending.clear();
      // a dropped connection cancels every inbound request in flight on it
      for (const controller of this.#inbound.values()) controller.abort();
      this.#inbound.clear();
      this.#seen.clear();
      this.#closed = true;
      for (const listener of this.#closeListeners.splice(0)) this.#runCloseListener(listener);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Run a close listener defensively: one that throws must not abort teardown
   * of the others. Log the failure to stderr and continue. */
  #runCloseListener(listener: () => void): void {
    try {
      listener();
    } catch (err) {
      process.stderr.write(`close listener threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
  }

  /** Serialize and write a message. Returns false when the connection is gone
   * (closed/destroyed/unwritable) or the payload cannot be serialized — the
   * caller may then fall back to a guaranteed-serializable answer. */
  send(msg: unknown): boolean {
    // a closed connection is an implicit terminator: traffic for requests that
    // were in flight on it is silently dropped
    if (this.#closed || this.#socket.destroyed || !this.#socket.writable) return false;
    let text: string;
    try {
      text = JSON.stringify(msg) + "\n";
    } catch {
      // cyclic/BigInt payload (e.g. an RpcError's own data) — cannot be framed
      return false;
    }
    this.#socket.write(text);
    return true;
  }

  onClose(listener: () => void): void {
    if (this.#closed) this.#runCloseListener(listener);
    else this.#closeListeners.push(listener);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    // a request on a closed connection can never be answered — reject at once
    // rather than leaving the returned promise forever pending
    if (this.#closed || this.#socket.destroyed || !this.#socket.writable) {
      return Promise.reject(new Error("connection closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (!this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })) {
        // the write failed after we registered the pending entry — settle it
        // rather than leak the promise
        this.#pending.delete(id);
        reject(new Error("connection closed"));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** True when an inbound request with this id has EVER been used on this
   * connection — in flight now or already completed. The no-reuse gate is by
   * connection lifetime, so this returns true for a completed id too. */
  hasSeenInbound(id: string | number): boolean {
    return this.#seen.has(id);
  }

  /** Spend an inbound request id: record it in the lifetime seen-set so it can
   * never be reused. Called for EVERY valid inbound request the moment it is
   * accepted — before method-existence and handshake routing — so an id is
   * spent regardless of how that first request is answered (result, -32601,
   * -32002, -32003). */
  markSeen(id: string | number): void {
    this.#seen.add(id);
  }

  /** Register a dispatched inbound request and return the AbortSignal its
   * handler receives. Called synchronously before the handler is awaited so a
   * pipelined duplicate id already sees this request in flight. */
  beginInbound(id: string | number): AbortSignal {
    const controller = new AbortController();
    this.#inbound.set(id, controller);
    return controller.signal;
  }

  /** Release a finished inbound request. */
  endInbound(id: string | number): void {
    this.#inbound.delete(id);
  }

  abortInbound(id: unknown): void {
    if (validId(id)) this.#inbound.get(id)?.abort();
  }

  /** Settle an inbound response against our outbound id space; unmatched
   * responses are dropped (the ids may belong to a confused peer). */
  settle(id: unknown, result: unknown, error: unknown): void {
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (error !== undefined) {
      const e = error as { code?: number; message?: string; data?: unknown };
      pending.reject(new RpcError(e?.code ?? 0, e?.message ?? "error", e?.data));
    } else {
      pending.resolve(result);
    }
  }
}

function errorResponse(id: unknown, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function createWireServer(handlers: Record<string, MethodHandler>): WireServer {
  const sockets = new Set<Socket>();

  async function dispatchRequest(conn: ServerConnection, id: string | number, method: string, params: unknown) {
    // No-reuse rule, enforced centrally across ALL methods and for the
    // connection's LIFETIME, and recorded BEFORE method-existence and handshake
    // routing: an id, once used on this connection, is spent regardless of how
    // that first request was answered (result, -32601, -32002, -32003).
    // Reusing an id would make response/notification correlation ambiguous, and
    // reusing a completed id would let a late `cancel` meant for the old request
    // abort a new one — so a `login` id and a `respond` id can never collide,
    // and an initialize retry after a rejection must use a FRESH id.
    if (conn.hasSeenInbound(id)) {
      conn.send(errorResponse(id, -32600, `invalid request: request id ${JSON.stringify(id)} has already been used on this connection`));
      return;
    }
    conn.markSeen(id);

    const isInitialize = method === "initialize";
    if (isInitialize) {
      // transport.md handshake: "initialize happens exactly once per
      // connection; a repeat is rejected." A second initialize — including one
      // pipelined into the same chunk while the first is still `initializing` —
      // is rejected, because the state left `uninitialized` synchronously below.
      if (conn.state !== "uninitialized") {
        conn.send(errorResponse(id, -32003, "already initialized"));
        return;
      }
    } else {
      // transport.md handshake: "Until initialize resolves, nothing else is
      // allowed on the connection: other requests are answered with an error."
      // This covers `initializing` too: a request pipelined behind a still-
      // unresolved initialize must not run.
      if (conn.state !== "initialized") {
        conn.send(errorResponse(id, -32002, "not initialized"));
        return;
      }
    }

    const handler = handlers[method];
    if (handler === undefined) {
      conn.send(errorResponse(id, -32601, `method not found: ${method}`));
      return;
    }

    // Claim the handshake synchronously, before awaiting the handler: a second
    // initialize pipelined into the same chunk is dispatched before the await
    // resolves and must already see the connection as `initializing`. Committed
    // to `initialized` ONLY after the handler resolves successfully.
    if (isInitialize) conn.state = "initializing";
    // Registered synchronously, before the first await, for the same reason the
    // no-reuse check above is synchronous: a pipelined duplicate id must
    // already see this request as in flight.
    const signal = conn.beginInbound(id);
    try {
      const result = await handler(params, conn, { id, signal });
      if (isInitialize) conn.state = "initialized";
      conn.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (err) {
      // A refused initialize (e.g. version mismatch) returns the connection to
      // `uninitialized` so the dialer may retry with a FRESH id.
      if (isInitialize) conn.state = "uninitialized";
      if (err instanceof RpcError) {
        // If the error's own data cannot be serialized (cyclic/BigInt), the
        // send is dropped — fall back to a guaranteed-serializable answer so
        // the request is still answered rather than left hanging.
        if (!conn.send(errorResponse(id, err.code, err.message, err.data))) {
          conn.send(errorResponse(id, -32603, "internal error"));
        }
      } else {
        // the wire answer is opaque by design; keep the real failure diagnosable
        process.stderr.write(`unhandled handler error in ${method}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        conn.send(errorResponse(id, -32603, "internal error"));
      }
    } finally {
      conn.endInbound(id);
    }
  }

  function handleMessage(conn: ServerConnection, line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // JSON-RPC 2.0: parse error, id null
      conn.send(errorResponse(null, -32700, "parse error"));
      return;
    }
    // transport.md envelope: batch arrays are excluded — one object per line
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      conn.send(errorResponse(null, -32600, "invalid request: expected a single JSON object"));
      return;
    }
    const m = msg as Record<string, unknown>;
    const hasId = "id" in m;
    const idValid = hasId && validId(m.id);
    // an error can only echo an id we can correlate; otherwise null
    const replyId = idValid ? m.id : null;

    // transport.md envelope: senders always tag `jsonrpc:"2.0"`; receivers
    // tolerate its ABSENCE, but a present tag that is not "2.0" is invalid.
    if ("jsonrpc" in m && m.jsonrpc !== "2.0") {
      conn.send(errorResponse(replyId, -32600, "invalid request: unsupported jsonrpc version"));
      return;
    }

    if (typeof m.method === "string") {
      if (hasId) {
        // a request: its id must be within the string|finite-number domain
        if (!idValid) {
          conn.send(errorResponse(null, -32600, "invalid request: id must be a string or a finite number"));
          return;
        }
        void dispatchRequest(conn, m.id as string | number, m.method, m.params);
      } else {
        // transport.md envelope: a notification "is never replied to, not
        // even with an error"; before the connection is initialized (including
        // while initializing), notifications are ignored.
        if (conn.state === "initialized") {
          const handler = handlers[m.method];
          if (handler !== undefined) {
            try {
              // notifications carry no id and own no request lifecycle: an
              // empty context, never a signal
              void Promise.resolve(handler(m.params, conn, {})).catch(() => {});
            } catch {
              // notification outcomes are never reported
            }
          }
        }
      }
      return;
    }

    // a response settles an outbound request. It must carry exactly one of
    // result/error; one carrying both is malformed and is dropped (never
    // crashes the connection), as is a response with an unusable id.
    const hasResult = "result" in m;
    const hasError = "error" in m;
    if (hasId && (hasResult || hasError)) {
      if (hasResult && hasError) return; // malformed response — ignore
      if (!idValid) return; // unusable id — cannot correlate, ignore
      conn.settle(m.id, m.result, m.error);
      return;
    }

    conn.send(errorResponse(replyId, -32600, "invalid request"));
  }

  let server: Server | undefined;

  return {
    listen(socketPath: string): Promise<void> {
      server = createServer((socket) => {
        sockets.add(socket);
        const conn = new ServerConnection(socket);
        const splitter = new LineSplitter();
        socket.on("data", (chunk: Buffer) => {
          let lines: string[];
          try {
            lines = splitter.push(chunk);
          } catch {
            // transport.md framing: close the connection when a line
            // exceeds the max message size
            socket.destroy();
            return;
          }
          for (const line of lines) handleMessage(conn, line);
        });
        socket.on("error", () => socket.destroy());
        socket.on("close", () => sockets.delete(socket));
      });
      const s = server;
      return new Promise((resolve, reject) => {
        s.once("error", reject);
        s.listen(socketPath, () => {
          s.removeListener("error", reject);
          resolve();
        });
      });
    },

    close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
