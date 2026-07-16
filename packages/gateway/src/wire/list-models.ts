import type { Models } from "@earendil-works/pi-ai";
import type { MethodHandler } from "@pino-agent/transport";

export function makeListModels(models: Models): MethodHandler {
  return () => ({
    // inference.md listModels: "a caller-relevant subset of the catalog's
    // model record; gateway-internal fields (base URLs, headers, compat
    // flags) are deliberately not exposed, and pricing is deferred" — so
    // this projection is exact, never a spread.
    models: models.getModels().map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });
}
