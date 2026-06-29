/**
 * ACP agent that binds an external ACP host to a single live pi `AgentSession`.
 *
 * Mirrors pi's own RPC mode (drive `AgentSession` from a line protocol), but
 * speaks ACP instead of pi-RPC. One instance is created per socket connection.
 *
 * M1 scope: text streaming + basic tool calls. No history replay, no permission
 * prompts over the socket (those stay in the TUI), no rich tool payloads.
 */

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type * as acp from "@agentclientprotocol/sdk";

/**
 * The subset of pi's `AgentSession` this agent drives. Kept structural so a
 * fake can stand in for tests and so we never depend on pi internals.
 */
export interface PinoAgentSession {
	readonly sessionId: string;
	subscribe(listener: (event: SessionEvent) => void): () => void;
	prompt(text: string, options?: { source?: string }): Promise<void>;
	abort(): Promise<void>;
}

/** The pi `AgentSession` events we map to ACP, narrowed to the fields we read. */
export type SessionEvent =
	| { type: "message_update"; assistantMessageEvent?: { type: string; delta?: string } }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName?: string }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "agent_end" }
	| { type: string };

const VERSION = "0.1.2";

export class PinoAcpAgent implements acp.Agent {
	private readonly conn: acp.AgentSideConnection;
	private readonly session: PinoAgentSession;
	private unsubscribe?: () => void;
	private resolveTurn?: () => void;
	private cancelled = false;

	constructor(conn: acp.AgentSideConnection, session: PinoAgentSession) {
		this.conn = conn;
		this.session = session;
	}

	async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "pino", version: VERSION },
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false },
			},
			authMethods: [],
		};
	}

	async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		return {};
	}

	async setSessionConfigOption(_params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
		// pino exposes no session config options. Television sets `verbose_level`
		// on connect, so accept and ignore it rather than 404 the whole connect.
		return { configOptions: [] };
	}

	async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		// M1: bind to the single live in-process session. No id bookkeeping, no
		// history replay — the client just sees the live session going forward.
		this.bind();
		return { sessionId: this.session.sessionId };
	}

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		this.bind();
		this.cancelled = false;
		const text = extractText(params.prompt);

		let turnError: unknown;
		const turnEnded = new Promise<void>((resolve) => {
			this.resolveTurn = resolve;
		});
		void this.session.prompt(text, { source: "rpc" }).catch((error: unknown) => {
			// pino rejects (rather than emitting agent_end) when a turn can't run —
			// e.g. no API key. Capture it so we can surface it instead of leaving
			// the client stuck on "Thinking…" with no content.
			turnError = error;
			this.resolveTurn?.();
		});
		await turnEnded;
		this.resolveTurn = undefined;

		if (turnError !== undefined && !this.cancelled) {
			const message = turnError instanceof Error ? turnError.message : String(turnError);
			this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `⚠️ ${message}` } });
		}
		return { stopReason: this.cancelled ? "cancelled" : "end_turn" };
	}

	async cancel(_params: acp.CancelNotification): Promise<void> {
		this.cancelled = true;
		await this.session.abort();
	}

	/** Subscribe to the live session (idempotent for this connection). */
	private bind(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.session.subscribe((event) => this.handleSessionEvent(event));
	}

	/**
	 * Tear down this connection's subscription. Call when the underlying socket
	 * closes so reconnecting clients don't leak subscribers on the live session.
	 */
	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.resolveTurn?.();
		this.resolveTurn = undefined;
	}

	private handleSessionEvent(event: SessionEvent): void {
		switch (event.type) {
			case "message_update": {
				const inner = (event as Extract<SessionEvent, { type: "message_update" }>).assistantMessageEvent;
				if (inner?.type === "text_delta" && typeof inner.delta === "string") {
					this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: inner.delta } });
				}
				break;
			}
			case "tool_execution_start": {
				const e = event as Extract<SessionEvent, { type: "tool_execution_start" }>;
				this.send({
					sessionUpdate: "tool_call",
					toolCallId: e.toolCallId,
					title: e.toolName,
					kind: mapKind(e.toolName),
					status: "in_progress",
					rawInput: e.args as Record<string, unknown>,
				});
				break;
			}
			case "tool_execution_update": {
				const e = event as Extract<SessionEvent, { type: "tool_execution_update" }>;
				this.send({ sessionUpdate: "tool_call_update", toolCallId: e.toolCallId, status: "in_progress" });
				break;
			}
			case "tool_execution_end": {
				const e = event as Extract<SessionEvent, { type: "tool_execution_end" }>;
				this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: e.toolCallId,
					status: e.isError ? "failed" : "completed",
					content: [{ type: "content", content: { type: "text", text: stringifyResult(e.result) } }],
					rawOutput: e.result as Record<string, unknown>,
				});
				break;
			}
			case "agent_end": {
				this.resolveTurn?.();
				break;
			}
		}
	}

	/** Fire a session update to the client; never let a write error escape. */
	private send(update: acp.SessionUpdate): void {
		void this.conn.sessionUpdate({ sessionId: this.session.sessionId, update }).catch(() => {});
	}
}

export function mapKind(toolName: string): acp.ToolKind {
	switch (toolName.toLowerCase()) {
		case "read":
			return "read";
		case "bash":
			return "execute";
		case "edit":
		case "write":
			return "edit";
		case "grep":
		case "find":
		case "ls":
			return "search";
		default:
			return "other";
	}
}

function extractText(blocks: acp.ContentBlock[]): string {
	return blocks
		.filter((block): block is Extract<acp.ContentBlock, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function stringifyResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === undefined || result === null) return "";
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}
