import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Static guards for gateway.md's V0 binding rules — no runtime, just the source
// tree and package manifest. These fail loudly if a rule is quietly broken.

const pkgDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(pkgDir, "src");

// gateway.md V0: "The pi-ai dependency is pinned exactly: @earendil-works/
// pi-ai@0.80.6. [inference.md]'s shapes are vendored from it, so version bumps
// are deliberate changes reviewed against both specs."
test("binding rule: @earendil-works/pi-ai is pinned to exactly 0.80.6", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const pinned = pkg.dependencies?.["@earendil-works/pi-ai"];
  assert.equal(pinned, "0.80.6", "pi-ai must be pinned exactly (no ^ or ~) at the vendored version");
});

/** Every .ts file under src/, recursively. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// gateway.md V0: "pi-ai's deprecated /compat surface is not used." Grep-based
// guard: no gateway source may import from @earendil-works/pi-ai/compat.
test("binding rule: no gateway source imports the deprecated pi-ai /compat surface", () => {
  const offenders: string[] = [];
  for (const file of srcFiles(srcDir)) {
    const text = fs.readFileSync(file, "utf8");
    if (/@earendil-works\/pi-ai\/compat/.test(text)) offenders.push(path.relative(pkgDir, file));
  }
  assert.deepEqual(offenders, [], "gateway src must not touch pi-ai's /compat surface");
});
