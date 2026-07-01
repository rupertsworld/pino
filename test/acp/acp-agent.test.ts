import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { acpSocketPath, startAcpSocketServer, type AcpSocketServer } from "../../src/acp/socket.ts";
import { createFakeSession, type FakeSession } from "../helpers/fake-session.ts";

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

async function connectClient(
	session: FakeSession | (() => FakeSession),
): Promise<{ client: RecordingClient; agent: acp.ClientSideConnection }> {
	const getSession = typeof session === "function" ? session : () => session;
	server = await startAcpSocketServer(getSession, stateDir);
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

	it("binds newSession to the live session id and advertises no config options", async () => {
		const fake = createFakeSession({ sessionId: "live-123" });
		const { agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const result = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		assert.equal(result.sessionId, "live-123");
		// Advertise an empty config surface so clients don't call
		// session/set_config_option (which pino doesn't implement).
		assert.deepEqual(result.configOptions, []);
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

	it("surfaces a prompt failure as an assistant message and ends the turn", async () => {
		const fake = createFakeSession();
		// pino rejects (no agent_end) when a turn can't run, e.g. missing API key.
		fake.onPrompt(() => {
			throw new Error("No API key found for openrouter.");
		});
		const { client, agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		const result = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });

		assert.equal(result.stopReason, "end_turn");
		const text = client.updates
			.map((u) => u.update)
			.filter((u): u is Extract<typeof u, { sessionUpdate: "agent_message_chunk" }> => u.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.content.type === "text" ? u.content.text : ""))
			.join("");
		assert.match(text, /No API key found for openrouter/);
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

	it("does not end the turn on a retryable agent_end (willRetry) and streams the retried run", async () => {
		const fake = createFakeSession();
		fake.onPrompt(() => {
			// pi emits agent_end{willRetry:true} on a retryable failure, retries, then
			// emits the final agent_end{willRetry:false}. The turn must only end on the latter.
			fake.emit({ type: "agent_end", willRetry: true });
			fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "after retry" } });
			fake.emit({ type: "agent_end", willRetry: false });
		});
		const { client, agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		const result = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
		assert.equal(result.stopReason, "end_turn");

		const chunks = client.updates
			.map((u) => u.update)
			.filter((u): u is Extract<typeof u, { sessionUpdate: "agent_message_chunk" }> => u.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.content.type === "text" ? u.content.text : ""));
		assert.deepEqual(chunks, ["after retry"], "text emitted after the willRetry:true agent_end must still stream");
	});

	it("follows a session switch via the accessor, forwarding new-session events and dropping the old subscription", async () => {
		const a = createFakeSession({ sessionId: "session-a" });
		const b = createFakeSession({ sessionId: "session-b" });
		let current: FakeSession = a;
		b.onPrompt(() => {
			b.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "from B" } });
			b.emit({ type: "agent_end" });
		});

		const { client, agent } = await connectClient(() => current);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		assert.equal(a.listenerCount, 1, "newSession should subscribe to the current session A");

		// Simulate a TUI session switch: the accessor now returns B.
		current = b;
		const result = await agent.prompt({ sessionId: "session-b", prompt: [{ type: "text", text: "hi" }] });
		assert.equal(result.stopReason, "end_turn");
		assert.deepEqual(b.prompts, ["hi"], "the prompt must be driven on the current session B");
		assert.equal(a.listenerCount, 0, "the old session A must have no remaining subscribers");

		const chunks = client.updates
			.map((u) => u.update)
			.filter((u): u is Extract<typeof u, { sessionUpdate: "agent_message_chunk" }> => u.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.content.type === "text" ? u.content.text : ""));
		assert.deepEqual(chunks, ["from B"], "events from the new session B must be forwarded");
	});

	it("passes streamingBehavior:followUp when the session is mid-turn (does not reject)", async () => {
		const fake = createFakeSession();
		fake.isStreaming = true;
		fake.onPrompt(() => {
			fake.emit({ type: "agent_end" });
		});
		const { agent } = await connectClient(fake);
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		const result = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "queued" }] });
		assert.equal(result.stopReason, "end_turn");
		assert.equal(fake.lastPromptOptions?.streamingBehavior, "followUp");
	});
});
