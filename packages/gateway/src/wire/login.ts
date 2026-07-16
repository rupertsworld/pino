import type {
  AuthEvent,
  AuthLoginCallbacks,
  AuthPrompt,
  Credential,
  CredentialStore,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import { RpcError, type Connection, type MethodHandler } from "@pino-agent/transport";
import { LOGIN_FAILED } from "./error-codes.ts";
import { redactSecrets } from "../redact.ts";

// --- wire shapes: explicit projections, never spreads ------------------------

/** inference.md authPrompt — exactly {type, message, placeholder?} or the
 * select shape with options [{id, label, description?}]. pi-ai's per-prompt
 * `signal` is process-local and never serialized. */
function wirePrompt(prompt: AuthPrompt): Record<string, unknown> {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: prompt.message,
      options: prompt.options.map((o) => ({
        id: o.id,
        label: o.label,
        ...(o.description === undefined ? {} : { description: o.description }),
      })),
    };
  }
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
  };
}

/** inference.md authEvent union; an event type pi-ai grows later is dropped
 * rather than leaked (the wire carries schema shapes only). */
function wireEvent(event: AuthEvent): Record<string, unknown> | undefined {
  switch (event.type) {
    case "auth_url":
      return {
        type: "auth_url",
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case "device_code":
      return {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
        ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
      };
    case "progress":
      return { type: "progress", message: event.message };
    default:
      return undefined;
  }
}

// --- prompt bridging ----------------------------------------------------------

/** Reject when `signal` fires while `p` is pending; the abandoned wire request
 * stays open — inference.md: "the gateway ignores responses to prompts whose
 * flow has already moved on" (a late {cancelled:true} settles into nothing). */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => {}); // the wire promise may lose the race; never an unhandled rejection
  if (signal.aborted) return Promise.reject(new Error("prompt aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("prompt aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * gateway.md: "login bridges pi-ai's two flow callbacks to the wire (question
 * → authPrompt, announcement → authEvent)". The returned function IS pi-ai's
 * `prompt` callback: it sends a server→client authPrompt REQUEST on the
 * login's connection and awaits the answer — {value} resolves the entered
 * string, {cancelled:true} REJECTS (pi-ai: "Rejects on cancel/abort"), which
 * aborts the flow. Values entered into secret/manual_code prompts are
 * collected into `enteredSecrets` as redaction targets for flow errors.
 */
function makePrompt(conn: Connection, enteredSecrets: string[]): (prompt: AuthPrompt) => Promise<string> {
  return async (prompt) => {
    const responseP = conn.request("authPrompt", wirePrompt(prompt));
    // AuthPrompt.signal is pi-ai's per-prompt cancellation: the flow resolved
    // this step another way (e.g. its loopback listener won the race)
    const response = prompt.signal === undefined ? await responseP : await raceSignal(responseP, prompt.signal);
    const r = (response !== null && typeof response === "object" ? response : {}) as Record<string, unknown>;
    if (r.cancelled === true) throw new Error("prompt declined");
    if (typeof r.value !== "string") throw new Error("malformed authPrompt response");
    if (prompt.type === "secret" || prompt.type === "manual_code") enteredSecrets.push(r.value);
    return r.value;
  };
}

// --- method selection ------------------------------------------------------------

interface Flow {
  id: "api_key" | "oauth";
  label: string;
  run: (callbacks: AuthLoginCallbacks) => Promise<Credential>;
}

/** The interactively drivable flows: an apiKey surface without `login` is
 * ambient-only (pi-ai: "Absent = ambient-only") and cannot be logged into. */
function loginableFlows(provider: Provider): Flow[] {
  const flows: Flow[] = [];
  const apiKey = provider.auth.apiKey;
  if (apiKey?.login !== undefined) {
    flows.push({ id: "api_key", label: apiKey.name, run: (cb) => apiKey.login!(cb) });
  }
  const oauth = provider.auth.oauth;
  if (oauth !== undefined) {
    flows.push({ id: "oauth", label: oauth.name, run: (cb) => oauth.login(cb) });
  }
  return flows;
}

// --- handler ---------------------------------------------------------------------

/**
 * inference.md `login`. Connection-scoped by construction: every authPrompt/
 * authEvent goes out on the initiating connection. One slot per connection
 * enforces "at most one login may be in flight per connection"; the slot's
 * single onClose hook implements "connection close aborts the flow".
 * `extraSecrets` (stored-credential values) redacts flow errors — slice C
 * carry-over: gho_/ya29./OAuth tokens carry no sk- shape.
 */
export function makeLogin(
  models: Models,
  credentials: CredentialStore,
  extraSecrets: () => Iterable<string> = () => [],
): MethodHandler {
  const slots = new WeakMap<Connection, { active?: AbortController }>();

  function slotFor(conn: Connection): { active?: AbortController } {
    let slot = slots.get(conn);
    if (slot === undefined) {
      const created: { active?: AbortController } = {};
      slots.set(conn, created);
      conn.onClose(() => created.active?.abort());
      slot = created;
    }
    return slot;
  }

  return async (params, conn) => {
    const p = (params !== null && typeof params === "object" ? params : {}) as Record<string, unknown>;
    if (typeof p.provider !== "string") {
      throw new RpcError(-32602, "invalid params: provider is required");
    }
    if (p.method !== undefined && p.method !== "api_key" && p.method !== "oauth") {
      throw new RpcError(-32602, 'invalid params: method must be "api_key" or "oauth"');
    }

    // inference.md: "at most one login may be in flight per connection (a
    // second is rejected with login_failed)"
    const slot = slotFor(conn);
    if (slot.active !== undefined) {
      throw new RpcError(LOGIN_FAILED, "a login is already in flight on this connection");
    }

    const provider = models.getProvider(p.provider);
    if (provider === undefined) {
      throw new RpcError(LOGIN_FAILED, `unknown provider: ${p.provider}`);
    }
    const flows = loginableFlows(provider);

    const controller = new AbortController();
    slot.active = controller;
    const enteredSecrets: string[] = [];
    const prompt = makePrompt(conn, enteredSecrets);
    try {
      let flow: Flow | undefined;
      if (p.method !== undefined) {
        flow = flows.find((f) => f.id === p.method);
        if (flow === undefined) {
          throw new RpcError(LOGIN_FAILED, `provider ${provider.id} does not support interactive ${p.method} login`);
        }
      } else if (flows.length === 0) {
        throw new RpcError(LOGIN_FAILED, `provider ${provider.id} has no interactive login`);
      } else if (flows.length === 1) {
        flow = flows[0];
      } else {
        // inference.md: "when method is omitted and the provider supports
        // several, the gateway asks via an authPrompt select" — the answer is
        // the chosen option id
        const chosen = await prompt({
          type: "select",
          message: `Choose a login method for ${provider.name}`,
          options: flows.map((f) => ({ id: f.id, label: f.label })),
        });
        flow = flows.find((f) => f.id === chosen);
        if (flow === undefined) {
          throw new RpcError(LOGIN_FAILED, `unknown login method: ${chosen}`);
        }
      }

      const credential = await flow.run({
        signal: controller.signal,
        prompt,
        notify: (event) => {
          const wire = wireEvent(event);
          if (wire !== undefined) conn.notify("authEvent", wire);
        },
      });
      // gateway.md: "a completed flow persists the credential". The store
      // serializes writes, so concurrent logins for one provider from
      // different connections are last-write-wins (inference.md).
      await credentials.modify(provider.id, async () => credential);
      // source follows authStatus's semantics for the credential just stored:
      // "OAuth" by presence, "stored credential" for a stored api key
      return { provider: provider.id, source: flow.id === "oauth" ? "OAuth" : "stored credential" };
    } catch (err) {
      if (err instanceof RpcError) throw err; // gateway-authored, no secrets
      // flow failure/decline/abort → login_failed, with the message redacted:
      // stored tokens AND anything the user just typed into a secret prompt
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(LOGIN_FAILED, redactSecrets(`login failed: ${message}`, [...extraSecrets(), ...enteredSecrets]));
    } finally {
      if (slot.active === controller) slot.active = undefined;
    }
  };
}
