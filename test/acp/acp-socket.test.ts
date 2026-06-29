import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acpSocketPath, startAcpSocketServer } from "../../src/acp/socket.ts";
import { createFakeSession } from "../helpers/fake-session.ts";

let stateDir: string;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "pino-acp-socket-"));
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
});

function canConnect(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

describe("acp socket lifecycle", () => {
	it("creates a listening socket at the expected path", async () => {
		const server = await startAcpSocketServer(() => createFakeSession(), stateDir);
		try {
			assert.equal(server.skipped, false);
			const path = acpSocketPath(stateDir);
			const info = await stat(path);
			assert.equal(info.isSocket(), true);
			assert.equal(await canConnect(path), true);
		} finally {
			await server.close();
		}
	});

	it("cleans up a stale socket file and rebinds", async () => {
		const path = acpSocketPath(stateDir);
		await writeFile(path, "stale");
		const server = await startAcpSocketServer(() => createFakeSession(), stateDir);
		try {
			assert.equal(server.skipped, false);
			assert.equal(await canConnect(path), true);
		} finally {
			await server.close();
		}
	});

	it("does not throw and reports skipped when a listener already holds the socket", async () => {
		const first = await startAcpSocketServer(() => createFakeSession(), stateDir);
		const second = await startAcpSocketServer(() => createFakeSession(), stateDir);
		try {
			assert.equal(first.skipped, false);
			assert.equal(second.skipped, true);
		} finally {
			await second.close();
			await first.close();
		}
	});

	it("removes the socket file on close", async () => {
		const path = acpSocketPath(stateDir);
		const server = await startAcpSocketServer(() => createFakeSession(), stateDir);
		await server.close();
		await assert.rejects(() => stat(path));
	});

	it("unsubscribes from the session when a client disconnects", async () => {
		const session = createFakeSession();
		const server = await startAcpSocketServer(() => session, stateDir);
		const path = acpSocketPath(stateDir);
		try {
			// Connect, drive a subscription via a prompt, then disconnect.
			const client = connect(path);
			await new Promise<void>((resolve, reject) => {
				client.once("connect", () => resolve());
				client.once("error", reject);
			});
			// The agent subscribes on first newSession/prompt. Send a minimal ACP
			// initialize+newSession so the agent binds, then wait for a listener.
			client.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
			);
			client.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/", mcpServers: [] } })}\n`,
			);
			await waitFor(() => session.listenerCount > 0);

			client.destroy();
			await waitFor(() => session.listenerCount === 0);
			assert.equal(session.listenerCount, 0);
		} finally {
			await server.close();
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
