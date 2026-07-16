import type { AuthContext, Credential, Models, Provider } from "@earendil-works/pi-ai";
import type { MethodHandler } from "@pino-agent/transport";
import type { FileCredentialStore } from "../storage/credentials.ts";

interface ProviderStatus {
  configured: boolean;
  source?: string;
}

/**
 * Status for one provider, mirroring pi-ai's resolveProviderAuth precedence
 * (a stored credential owns the provider; ambient env is consulted only when
 * nothing is stored) — but side-effect-free: authStatus must never make a
 * network call, so a stored OAuth credential is reported by presence instead
 * of being resolved (resolution would refresh an expired token). The stored
 * credential is looked up from a whole-file snapshot the caller reads once.
 */
async function providerStatus(
  provider: Provider,
  models: Models,
  stored: Credential | undefined,
  ctx: AuthContext,
): Promise<ProviderStatus> {
  if (stored?.type === "oauth") {
    // no matching handler for the stored type means unconfigured — pi-ai
    // does no silent env fallback past a stored credential, nor do we
    return provider.auth.oauth ? { configured: true, source: "OAuth" } : { configured: false };
  }
  if (stored !== undefined && stored.type !== "api_key") {
    // hand-edited auth.json with an unrecognized type tag: pi-ai's
    // resolveProviderAuth treats any stored credential without a matching
    // handler as unconfigured (no env fallback), so respond would fail —
    // report the same here rather than a configured:true lie
    return { configured: false };
  }
  if (!provider.auth.apiKey) return { configured: false };
  // apiKey resolve() takes the model the request is for; any model of the
  // provider is representative for status (best-effort via Models)
  const model = models.getModels(provider.id)[0];
  if (model === undefined) {
    // dynamic provider before its first refresh: nothing to resolve against;
    // a stored credential still counts as configured, ambient is unknowable
    return stored !== undefined ? { configured: true, source: "stored credential" } : { configured: false };
  }
  try {
    const result = await provider.auth.apiKey.resolve({ model, ctx, credential: stored });
    if (result === undefined) return { configured: false };
    return { configured: true, ...(result.source === undefined ? {} : { source: result.source }) };
  } catch {
    // a throwing resolve() degrades that one provider to unconfigured;
    // deliberate: a broken resolver shouldn't take down the whole answer.
    // (A rejecting credentials.read — corrupt auth.json — is different and
    // DOES fail the whole authStatus: the store is shared state and a loud
    // -32603 beats a fabricated all-unconfigured answer.)
    return { configured: false };
  }
}

export function makeAuthStatus(models: Models, credentials: FileCredentialStore, ctx: AuthContext): MethodHandler {
  return async () => {
    // read + parse auth.json once for the whole call; a corrupt file throws
    // here and fails the call, exactly as a per-provider read() would have
    const snapshot = credentials.readAll();
    return {
      providers: await Promise.all(
        models.getProviders().map(async (provider) => {
          const methods = [
            ...(provider.auth.apiKey ? ["api_key" as const] : []),
            ...(provider.auth.oauth ? ["oauth" as const] : []),
          ];
          const { configured, source } = await providerStatus(provider, models, snapshot[provider.id], ctx);
          return {
            provider: provider.id,
            name: provider.name,
            methods,
            configured,
            // inference.md: optional fields are omitted when absent, never null
            ...(source === undefined ? {} : { source }),
          };
        }),
      ),
    };
  };
}
