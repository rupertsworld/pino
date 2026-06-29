import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { acpSocketPath, startAcpSocketServer, type AcpSocketServer } from "../src/acp/socket.ts";
import { createFakeSession, type FakeSession } from "./helpers/fake-session.ts";

class RecordingClient implements acp.Client {
	readonly updates: acp.SessionNotification[] = [];

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async requestPermission(): Promise<acp.RequestPermissionResponse> {
		throw new Error("requestPermission should not be called in M1");
	}
}

let stateDir: string;
let server: AcpSocketServer;
let socket: Socket;

async function connectClient(fake: FakeSession): Promise<{ client: RecordingClient; agent: acp.ClientSideConnection }> {
	server = await startAcpSocketServer(fake, stateDir);
	const path = acpSocketPath(stateDir);
	socket = connect(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const stream = acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket));
	const client = new RecordingClient();
	const agent = new acp.ClientSideConnection(() => client, stream);
	return { client, agent };
}

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "pino-acp-agent-"));
});

afterEach(async () => {
	socket?.destroy();
	await server?.close();
	await rm(stateDir, { recursive: true, force: true });
});

describe("acp agent round-trip", () => {
	it("returns expected capabilities from initialize", async () => {
		const { agent } = await connectClient(createFakeSession());
		const result = await agent.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
		});
		assert.equal(result.protocolVersion, acp.PROTOCOL_VERSION);
		assert.equal(result.agentCapabilities?.loadSession, false);
		assert.equal(result.agentCapabilities?.promptCapabilities?.image, false);
		assert.equal(result.agentInfo?.name, "pino");
	});

	it("binds newSession to the live session id", async () => {
		const fake = createFakeSession({ sessionId: "live-123" });
		const { agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const result = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		assert.equal(result.sessionId, "live-123");
	});

	it("streams text deltas as agent_message_chunk and ends with end_turn", async () => {
		const fake = createFakeSession();
		fake.onPrompt(() => {
			fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
			fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
			fake.emit({ type: "agent_end" });
		});
		const { client, agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		const result = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "hi there" }],
		});

		assert.equal(result.stopReason, "end_turn");
		assert.deepEqual(fake.prompts, ["hi there"]);

		const chunks = client.updates
			.map((u) => u.update)
			.filter((u): u is Extract<typeof u, { sessionUpdate: "agent_message_chunk" }> => u.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.content.type === "text" ? u.content.text : ""));
		assert.deepEqual(chunks, ["Hello", " world"]);
	});

	it("maps a tool execution start/end pair to tool_call and tool_call_update", async () => {
		const fake = createFakeSession();
		fake.onPrompt(() => {
			fake.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/a" } });
			fake.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "file contents", isError: false });
			fake.emit({ type: "agent_end" });
		});
		const { client, agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });

		const updates = client.updates.map((u) => u.update);
		const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
		assert.ok(toolCall, "expected a tool_call update");
		assert.equal(toolCall.toolCallId, "t1");
		assert.equal(toolCall.title, "read");
		assert.equal(toolCall.kind, "read");
		assert.equal(toolCall.status, "in_progress");

		const toolUpdate = updates.find((u) => u.sessionUpdate === "tool_call_update");
		assert.ok(toolUpdate, "expected a tool_call_update update");
		assert.equal(toolUpdate.toolCallId, "t1");
		assert.equal(toolUpdate.status, "completed");
	});

	it("answers setSessionConfigOption without erroring (Television connect path)", async () => {
		const fake = createFakeSession({ sessionId: "live-cfg" });
		const { agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		const result = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "verbose_level",
			value: "full",
		});
		assert.ok(Array.isArray(result.configOptions));
	});

	it("resolves with cancelled when cancel is received during a turn", async () => {
		const fake = createFakeSession();
		const { agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		// Mirror pi: aborting the session ends the turn.
		fake.onAbort(() => fake.emit({ type: "agent_end" }));
		fake.onPrompt(() => {
			void agent.cancel({ sessionId: session.sessionId });
		});

		const result = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "long task" }],
		});
		assert.equal(result.stopReason, "cancelled");
		assert.equal(fake.abortCount, 1);
	});
});
