import fs from "node:fs";
import { createRequire } from "node:module";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { createWireServer, makeInitialize } from "@pino-agent/transport";
import { makeListModels } from "./wire/list-models.ts";
import { makeAuthStatus } from "./wire/auth-status.ts";
import { makeRespondHandlers } from "./wire/respond.ts";
import { makeLogin } from "./wire/login.ts";
import { makeLogout } from "./wire/logout.ts";
import { createCatalog } from "./catalog.ts";
import { FileCredentialStore } from "./storage/credentials.ts";
import { resolveStateDir, prepareRunDir, claimGatewaySingleton, SingletonError } from "@pino-agent/storage";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const stateDir = resolveStateDir();
const runDir = prepareRunDir(stateDir);

// storage.md: descriptor and socket are removed on clean shutdown, and the
// singleton lock released. The handlers are registered BEFORE the descriptor
// is published so a signal arriving the instant the descriptor becomes
// visible still shuts down cleanly. `claimed` guards the cleanup: a refusing
// process must never unlink the live gateway's descriptor or socket, nor
// release its lock.
let claimed = false;
let descriptorPath = "";
let socketPath = "";
let release: () => void = () => {};
function shutdown(): void {
  if (claimed) {
    fs.rmSync(descriptorPath, { force: true });
    fs.rmSync(socketPath, { force: true });
    release(); // free the singleton lock (storage.md ^storage-singleton)
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  // storage.md ^storage-singleton: acquire the singleton lock before the
  // socket is bound
  ({ descriptorPath, socketPath, release } = claimGatewaySingleton(runDir));
  claimed = true;
} catch (err) {
  if (err instanceof SingletonError) {
    process.stderr.write(`pino-gateway: ${err.message}; refusing to start\n`);
    process.exit(1);
  }
  throw err;
}

const credentials = new FileCredentialStore(stateDir);
const authContext = defaultProviderAuthContext();
const models = createCatalog(credentials, authContext);
// stored-credential values are extra redaction targets for logged/wire flow
// errors (gateway.md: "known secret patterns redacted")
const storedSecrets = () => credentials.secretValues();
const { respond, cancel } = makeRespondHandlers(models, undefined, storedSecrets);
const server = createWireServer({
  // inference.md: the gateway serves schema "pino.inference", version 1
  initialize: makeInitialize("pino.inference", [1], { name: "pino-gateway", version: pkg.version }),
  listModels: makeListModels(models),
  authStatus: makeAuthStatus(models, credentials, authContext),
  respond,
  cancel,
  login: makeLogin(models, credentials, storedSecrets),
  logout: makeLogout(credentials),
});

try {
  await server.listen(socketPath);
} catch (err) {
  // never leave a claim we are not serving
  fs.rmSync(descriptorPath, { force: true });
  fs.rmSync(socketPath, { force: true });
  release();
  throw err;
}
process.stderr.write(`pino-gateway listening on ${socketPath}\n`);
