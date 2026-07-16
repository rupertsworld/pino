import { RpcError, type MethodHandler } from "./server.ts";

export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * transport.md handshake: the `initialize` mechanism, schema-agnostic. The
 * caller names the schema and the versions it speaks (transport.md: "schema
 * names and version numbers are declared by each schema spec, not this
 * document"); the handler accepts by echoing the requested version, or refuses
 * with `-32602` invalid params carrying `data: {supported: [...]}`.
 */
export function makeInitialize(schema: string, supportedVersions: readonly number[], serverInfo: ServerInfo): MethodHandler {
  return (params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (p.schema !== schema || !supportedVersions.includes(p.version as number)) {
      throw new RpcError(
        -32602,
        `unsupported schema/version; this server speaks ${schema} versions ${supportedVersions.join(", ")}`,
        { supported: [...supportedVersions] },
      );
    }
    // transport.md: clientInfo is identification for logs only — no
    // behavior may key off it, so it is deliberately unused here.
    return { version: p.version, serverInfo };
  };
}
