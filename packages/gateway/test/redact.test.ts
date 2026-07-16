import { test } from "node:test";
import assert from "node:assert/strict";
import { knownEnvSecrets, redactSecrets } from "../src/redact.ts";

// gateway.md: failed turns are logged "with request bodies never logged and
// known secret patterns redacted". The redaction is deliberately dumb:
// a fixed key-shaped pattern plus the values of secret-looking env vars.

test("redactSecrets: sk- shaped keys are redacted, every occurrence", () => {
  const line = "auth failed for sk-ant-abc123XYZ and again sk-proj_9f8e7d6c";
  assert.equal(redactSecrets(line, []), "auth failed for [redacted] and again [redacted]");
});

test("redactSecrets: short sk- prefixes are not key-shaped and stay", () => {
  // fewer than 8 body chars — not a plausible key, leave it (dumb on purpose)
  assert.equal(redactSecrets("skipped sk-abc here", []), "skipped sk-abc here");
});

test("redactSecrets: explicit secret values are redacted verbatim", () => {
  const line = "token was hunter2hunter2, twice: hunter2hunter2";
  assert.equal(redactSecrets(line, ["hunter2hunter2"]), "token was [redacted], twice: [redacted]");
});

test("redactSecrets: secrets shorter than 8 chars are never substituted", () => {
  // redacting tiny strings would shred ordinary words; leave them
  assert.equal(redactSecrets("no such e in here", ["e"]), "no such e in here");
});

test("knownEnvSecrets: collects values of secret-looking env names only", () => {
  const env = {
    FAKE_API_KEY: "sk1234567890",
    GITHUB_TOKEN: "ghp_abcdef123456",
    CLIENT_SECRET: "shhh-very-secret",
    DB_PASSWORD: "correct-horse-battery",
    AWS_CREDENTIALS: "aki-and-sak-pair",
    HOME: "/home/someone-long-enough",
    SHORT_KEY: "tiny", // under the 8-char floor: not usable as a redaction target
  };
  assert.deepEqual(knownEnvSecrets(env).sort(), [
    "aki-and-sak-pair",
    "correct-horse-battery",
    "ghp_abcdef123456",
    "shhh-very-secret",
    "sk1234567890",
  ]);
});

test("redactSecrets: default secret list comes from the process env", () => {
  process.env.PINO_TEST_REDACT_KEY = "super-secret-value-123";
  try {
    assert.equal(redactSecrets("leaked super-secret-value-123 today"), "leaked [redacted] today");
  } finally {
    delete process.env.PINO_TEST_REDACT_KEY;
  }
});

// slice C carry-over: the second parameter is EXTRA secrets on top of the
// env-derived set — stored-credential tokens (gho_, ya29., OAuth access
// tokens) that no pattern catches — so env redaction never regresses when
// callers thread extras through.
test("redactSecrets: extra secrets redact alongside env secrets", () => {
  process.env.PINO_TEST_REDACT_KEY2 = "env-secret-value-9";
  try {
    assert.equal(
      redactSecrets("saw env-secret-value-9 and gho_extratoken77 together", ["gho_extratoken77"]),
      "saw [redacted] and [redacted] together",
    );
  } finally {
    delete process.env.PINO_TEST_REDACT_KEY2;
  }
});
