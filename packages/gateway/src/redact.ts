// gateway.md: failed turns are logged "with request bodies never logged and
// known secret patterns redacted". The redaction is deliberately dumb: a
// fixed key-shaped pattern plus the literal values of secret-looking env
// vars. It is a log hygiene measure, not a security boundary.

/** Key-shaped substrings redacted wherever they appear (e.g. sk-... API keys). */
const SECRET_PATTERNS: RegExp[] = [/sk-[A-Za-z0-9_-]{8,}/g];

/** Env var names whose values are presumed secret. */
const SECRETISH_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** Below this length a value is not usable as a redaction target: substituting
 * tiny strings would shred ordinary words. */
const MIN_SECRET_LENGTH = 8;

export function knownEnvSecrets(env: Record<string, string | undefined> = process.env): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= MIN_SECRET_LENGTH && SECRETISH_ENV_NAME.test(name)) {
      secrets.push(value);
    }
  }
  return secrets;
}

/** Redact key-shaped patterns, secret-looking env values, and any
 * `extraSecrets` the caller knows about (stored-credential tokens, values a
 * user typed into a secret prompt) — extras ADD to the env set, so threading
 * them through never regresses env redaction. */
export function redactSecrets(text: string, extraSecrets: Iterable<string> = []): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  for (const secret of [...knownEnvSecrets(), ...extraSecrets]) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[redacted]");
  }
  return out;
}
