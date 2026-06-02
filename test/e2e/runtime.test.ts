import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestDirs, removeTestDirs, runPino, type TestDirs } from "../helpers/run-pino.ts";

let dirs: TestDirs;

beforeEach(async () => {
	dirs = await createTestDirs();
	await mkdir(dirs.home, { recursive: true });
	await mkdir(dirs.state, { recursive: true });
	await mkdir(dirs.workspace, { recursive: true });
});

afterEach(async () => {
	await removeTestDirs(dirs);
});

describe("runtime resource isolation", () => {
	it("loads Pino skills without discovering ~/.agents skill conflicts", async () => {
		await mkdir(join(dirs.home, ".agents", "skills", "cron"), { recursive: true });
		await writeFile(
			join(dirs.home, ".agents", "skills", "cron", "SKILL.md"),
			"---\nname: cron\ndescription: External cron skill\n---\nExternal.\n",
			"utf8",
		);

		await mkdir(join(dirs.state, "skills", "cron"), { recursive: true });
		await writeFile(
			join(dirs.state, "skills", "cron", "SKILL.md"),
			"---\nname: cron\ndescription: Pino cron skill\n---\nPino.\n",
			"utf8",
		);

		const result = await runPino([], dirs, { PINO_INTERNAL_DUMP_RUNTIME: "1" });
		assert.equal(result.exitCode, 0, result.stderr);

		const debug = parseJsonFromOutput(result.stdout) as {
			env: { PI_SKIP_VERSION_CHECK?: string };
			skills: Array<{ name: string; filePath: string }>;
			diagnostics: Array<{ message?: string; path?: string }>;
		};

		assert.equal(debug.env.PI_SKIP_VERSION_CHECK, "1");

		assert.deepEqual(
			debug.skills.map((skill) => skill.name),
			["cron"],
		);
		assert.equal(debug.skills[0]?.filePath, join(dirs.state, "skills", "cron", "SKILL.md"));
		assert.equal(JSON.stringify(debug).includes(".agents"), false);
		assert.equal(JSON.stringify(debug.diagnostics).includes("Skill conflicts"), false);
	});

	it("scaffolds default state without overwriting existing files", async () => {
		const result = await runPino([], dirs, { PINO_INTERNAL_DUMP_RUNTIME: "1" });
		assert.equal(result.exitCode, 0, result.stderr);

		const settings = JSON.parse(await readFile(join(dirs.state, "settings.json"), "utf8")) as { packages?: string[]; systemPrompt?: string; contextFiles?: string[]; timeZone?: string };
		assert.deepEqual(settings.packages, ["npm:@llblab/pi-telegram@0.15.0", "npm:pi-schedule-prompt"]);
		assert.equal(settings.systemPrompt, "SYSTEM.md");
		assert.equal(settings.timeZone, "Australia/Sydney");
		assert.deepEqual(settings.contextFiles, ["AGENTS.md"]);
		assert.match(await readFile(join(dirs.state, "SYSTEM.md"), "utf8"), /You are Pino/);
		assert.equal(await readFile(join(dirs.state, "AGENTS.md"), "utf8"), "");
		assert.equal((await stat(join(dirs.state, "skills"))).isDirectory(), true);
	});

	it("renders SYSTEM.md variables", async () => {
		await writeFile(join(dirs.state, "SYSTEM.md"), "state={{STATE_DIR}} workspace={{WORKSPACE_DIR}} date={{DATE}} time={{TIME}} tz={{TZ}}", "utf8");

		const result = await runPino([], dirs, { PINO_INTERNAL_DUMP_RUNTIME: "1" });
		assert.equal(result.exitCode, 0, result.stderr);

		const debug = parseJsonFromOutput(result.stdout) as { systemPrompt: string };
		assert.match(debug.systemPrompt, new RegExp(`^state=${escapeRegExp(dirs.state)} workspace=${escapeRegExp(dirs.workspace)} date=\\d{4}-\\d{2}-\\d{2} time=\\d{2}:\\d{2}:\\d{2} tz=\\S+$`));
		assert.equal(debug.systemPrompt.includes("{{"), false);
	});

	it("renders DATE, TIME, and TZ using settings.timeZone", async () => {
		await writeFile(join(dirs.state, "settings.json"), JSON.stringify({
			packages: ["npm:@llblab/pi-telegram@0.15.0"],
			systemPrompt: "SYSTEM.md",
			contextFiles: [],
			timeZone: "Australia/Sydney",
		}, null, "\t"), "utf8");
		await writeFile(join(dirs.state, "SYSTEM.md"), "date={{DATE}} time={{TIME}} tz={{TZ}}", "utf8");

		const result = await runPino([], dirs, {
			PINO_INTERNAL_DUMP_RUNTIME: "1",
			TZ: "UTC",
		});
		assert.equal(result.exitCode, 0, result.stderr);

		const debug = parseJsonFromOutput(result.stdout) as { systemPrompt: string };
		assert.match(debug.systemPrompt, /^date=\d{4}-\d{2}-\d{2} time=\d{2}:\d{2}:\d{2} tz=Australia\/Sydney$/);
	});

	it("rejects old Pino-prefixed SYSTEM.md variables", async () => {
		await writeFile(join(dirs.state, "SYSTEM.md"), "state={{PINO_STATE_DIR}} workspace={{PINO_WORKSPACE}}", "utf8");

		const result = await runPino([], dirs, { PINO_INTERNAL_DUMP_RUNTIME: "1" });
		assert.notEqual(result.exitCode, 0);
		assert.match(result.stderr, /Unknown SYSTEM\.md template variable: \{\{PINO_STATE_DIR\}\}/);
	});

	it("warns and uses an empty system prompt when configured systemPrompt is missing", async () => {
		await writeFile(join(dirs.state, "settings.json"), JSON.stringify({
			packages: ["npm:@llblab/pi-telegram@0.15.0"],
			systemPrompt: "MISSING.md",
			contextFiles: [],
		}, null, "\t"), "utf8");

		const result = await runPino([], dirs, { PINO_INTERNAL_DUMP_RUNTIME: "1" });
		assert.equal(result.exitCode, 0, result.stderr);
		assert.match(result.stderr, /Warning: systemPrompt file not found: .*MISSING\.md\. Using an empty system prompt\./);

		const debug = parseJsonFromOutput(result.stdout) as { systemPrompt: string };
		assert.equal(debug.systemPrompt, "");
	});

	it("resolves systemPrompt and contextFiles relative to settings.json", async () => {
		await mkdir(join(dirs.state, "prompts"), { recursive: true });
		await mkdir(join(dirs.state, "context"), { recursive: true });
		await writeFile(join(dirs.state, "settings.json"), JSON.stringify({
			packages: ["npm:@llblab/pi-telegram@0.15.0"],
			systemPrompt: "prompts/SYSTEM.md",
			contextFiles: ["context/ONE.md"],
		}, null, "\t"), "utf8");
		await writeFile(join(dirs.state, "prompts", "SYSTEM.md"), "state={{STATE_DIR}}", "utf8");
		await writeFile(join(dirs.state, "context", "ONE.md"), "context one", "utf8");
		await writeFile(join(dirs.state, "AGENTS.md"), "should not be loaded", "utf8");

		const result = await runPino([], dirs, { PINO_INTERNAL_DUMP_RUNTIME: "1" });
		assert.equal(result.exitCode, 0, result.stderr);

		const debug = parseJsonFromOutput(result.stdout) as { systemPrompt: string; agentsFiles: Array<{ path: string; content: string }> };
		assert.equal(debug.systemPrompt, `state=${dirs.state}`);
		assert.deepEqual(debug.agentsFiles, [{ path: join(dirs.state, "context", "ONE.md"), content: "context one" }]);
	});
});

function parseJsonFromOutput(output: string): unknown {
	const start = output.indexOf("{");
	assert.notEqual(start, -1, output);
	return JSON.parse(output.slice(start));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
