import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDynamicSystemPromptExtension } from "../../src/dynamic-system-prompt.ts";
import { createTestDirs, removeTestDirs, type TestDirs } from "../helpers/run-pino.ts";

let dirs: TestDirs;

describe("dynamic system prompt extension", () => {
	it("renders SYSTEM.md variables on every turn using the latest settings", async () => {
		dirs = await createTestDirs();
		try {
			await mkdir(dirs.state, { recursive: true });
			await mkdir(dirs.workspace, { recursive: true });
			await writeFile(join(dirs.state, "settings.json"), JSON.stringify({ timeZone: "Australia/Sydney" }), "utf8");

			let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt?: string } | undefined>) | undefined;
			await createDynamicSystemPromptExtension({
				stateDir: dirs.state,
				workspace: dirs.workspace,
				packageRoot: dirs.root,
			})({
				on(event: string, handler: typeof beforeAgentStart) {
					if (event === "before_agent_start") beforeAgentStart = handler;
				},
			} as never);

			assert.ok(beforeAgentStart);
			const first = await beforeAgentStart({ systemPrompt: "tz={{TZ}}" });
			assert.equal(first?.systemPrompt, "tz=Australia/Sydney");

			await writeFile(join(dirs.state, "settings.json"), JSON.stringify({ timeZone: "America/Los_Angeles" }), "utf8");
			const second = await beforeAgentStart({ systemPrompt: "tz={{TZ}}" });
			assert.equal(second?.systemPrompt, "tz=America/Los_Angeles");
		} finally {
			await removeTestDirs(dirs);
		}
	});
});
