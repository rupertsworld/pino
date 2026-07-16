import type { CredentialStore } from "@earendil-works/pi-ai";
import { RpcError, type MethodHandler } from "@pino-agent/transport";

/**
 * inference.md logout: "Deletes the stored credential; ambient sources
 * (environment variables) are unaffected. Result: {}." Delete is idempotent,
 * so an unknown or never-configured provider succeeds too — there is nothing
 * stored for it either way.
 */
export function makeLogout(credentials: CredentialStore): MethodHandler {
  return async (params) => {
    const p = (params !== null && typeof params === "object" ? params : {}) as Record<string, unknown>;
    if (typeof p.provider !== "string") {
      throw new RpcError(-32602, "invalid params: provider is required");
    }
    await credentials.delete(p.provider);
    return {};
  };
}
