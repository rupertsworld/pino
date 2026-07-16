import type { AuthContext, CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** gateway.md catalog: "The v0 implementation adopts pi-ai's stock catalog
 * and auth resolution wholesale" — the gateway's Models is pi-ai's builtin
 * set over our file-backed credential store. */
export function createCatalog(credentials: CredentialStore, authContext?: AuthContext): MutableModels {
  return builtinModels({ credentials, ...(authContext === undefined ? {} : { authContext }) });
}
