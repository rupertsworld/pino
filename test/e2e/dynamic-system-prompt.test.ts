import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDynamicSystemPromptExtension } from "../../src/dynamic-system-prompt.ts";
import { createTestDirs, removeTestDirs, type TestDirs } from "../helpers/run-pino.ts";

let dirs: TestDirs;

type BeforeAgentStartHandler = (event: {
	systemPrompt: string;
	systemPromptOptions?: {
		customPrompt?: string;
		contextFiles?: Array<{ path: string; content: string }>;
		cwd: string;
	};
}) => Promise<{ systemPrompt?: string } | undefined>;

describe("dynamic system prompt extension", () => {
	it("renders SYSTEM.md variables on every turn using the latest settings", async () => {
		dirs = await createTestDirs();
		try {
			await mkdir(dirs.state, { recursive: true });
			await mkdir(dirs.workspace, { recursive: true });
			await writeFile(join(dirs.state, "settings.json"), JSON.stringify({ timeZone: "Australia/Sydney" }), "utf8");

			let beforeAgentStart: BeforeAgentStartHandler | undefined;
			await createDynamicSystemPromptExtension({
				stateDir: dirs.state,
				workspace: dirs.workspace,
				packageRoot: dirs.root,
			})({
				on(event: string, handler: BeforeAgentStartHandler) {
					if (event === "before_agent_start") beforeAgentStart = handler;
				},
			} as never);

			assert.ok(beforeAgentStart);
			const first = await beforeAgentStart({ systemPrompt: "tz={{TZ}}", systemPromptOptions: { customPrompt: "tz={{TZ}}", cwd: dirs.workspace } });
			assert.equal(first?.systemPrompt, "tz=Australia/Sydney");

			await writeFile(join(dirs.state, "settings.json"), JSON.stringify({ timeZone: "America/Los_Angeles" }), "utf8");
			const second = await beforeAgentStart({ systemPrompt: "tz={{TZ}}", systemPromptOptions: { customPrompt: "tz={{TZ}}", cwd: dirs.workspace } });
			assert.equal(second?.systemPrompt, "tz=America/Los_Angeles");
		} finally {
			await removeTestDirs(dirs);
		}
	});

	it("re-reads configured context files on every turn", async () => {
		dirs = await createTestDirs();
		try {
			await mkdir(dirs.state, { recursive: true });
			await mkdir(dirs.workspace, { recursive: true });
			const contextPath = join(dirs.state, "AGENTS.md");
			await writeFile(join(dirs.state, "settings.json"), JSON.stringify({
				systemPrompt: "SYSTEM.md",
				contextFiles: ["AGENTS.md"],
			}), "utf8");
			await writeFile(join(dirs.state, "SYSTEM.md"), "system one", "utf8");
			await writeFile(contextPath, "context one", "utf8");

			let beforeAgentStart: BeforeAgentStartHandler | undefined;
			await createDynamicSystemPromptExtension({
				stateDir: dirs.state,
				workspace: dirs.workspace,
				packageRoot: dirs.root,
			})({
				on(event: string, handler: BeforeAgentStartHandler) {
					if (event === "before_agent_start") beforeAgentStart = handler;
				},
			} as never);

			assert.ok(beforeAgentStart);
			const first = await beforeAgentStart({
				systemPrompt: `system one\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${contextPath}">\ncontext one\n</project_instructions>\n\n</project_context>\nCurrent date: 2026-01-01`,
				systemPromptOptions: {
					customPrompt: "system one",
					contextFiles: [{ path: contextPath, content: "context one" }],
					cwd: dirs.workspace,
				},
			});
			assert.match(first?.systemPrompt ?? "", /context one/);

			await writeFile(contextPath, "context two", "utf8");
			await writeFile(join(dirs.state, "SYSTEM.md"), "system two", "utf8");
			const second = await beforeAgentStart({
				systemPrompt: first?.systemPrompt ?? "",
				systemPromptOptions: {
					customPrompt: "system one",
					contextFiles: [{ path: contextPath, content: "context one" }],
					cwd: dirs.workspace,
				},
			});

			assert.match(second?.systemPrompt ?? "", /system two/);
			assert.match(second?.systemPrompt ?? "", /context two/);
			assert.doesNotMatch(second?.systemPrompt ?? "", /system one/);
			assert.doesNotMatch(second?.systemPrompt ?? "", /context one/);
		} finally {
			await removeTestDirs(dirs);
		}
	});
});
