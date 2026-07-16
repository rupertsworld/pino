// inference.md application error codes — owned by inference.md, raised by the
// gateway's handlers. Kept out of @pino-agent/transport: they are
// inference-specific, and transport is provider-agnostic substrate.
export const MODEL_NOT_FOUND = 1;
export const PROVIDER_NOT_CONFIGURED = 2;
export const RESPONSE_FAILED = 3;
export const ABORTED = 4;
export const LOGIN_FAILED = 5;
