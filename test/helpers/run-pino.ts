import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface TestDirs {
	root: string;
	home: string;
	state: string;
	workspace: string;
}

export async function createTestDirs(): Promise<TestDirs> {
	const root = await mkdtemp(join(tmpdir(), "pino-test-"));
	return {
		root,
		home: join(root, "home"),
		state: join(root, "state"),
		workspace: join(root, "workspace"),
	};
}

export async function removeTestDirs(dirs: TestDirs): Promise<void> {
	await rm(dirs.root, { recursive: true, force: true });
}

export function runPino(
	args: string[],
	dirs: TestDirs,
	envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	const repoRoot = resolve(import.meta.dirname, "..", "..");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["src/cli.ts", ...args], {
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: dirs.home,
				PINO_STATE_DIR: dirs.state,
				PINO_WORKSPACE: dirs.workspace,
				...envOverrides,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
	});
}
