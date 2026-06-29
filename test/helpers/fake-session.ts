import type { PinoAgentSession, SessionEvent } from "../../src/acp/agent.ts";

export interface FakeSession extends PinoAgentSession {
	/** Synchronously deliver an event to every current subscriber. */
	emit(event: SessionEvent): void;
	/** Register a callback invoked with the prompt text when `prompt()` is called. */
	onPrompt(handler: (text: string) => void): void;
	/** Register a callback invoked when `abort()` is called (mirrors pi: abort ends the turn). */
	onAbort(handler: () => void): void;
	/** Texts passed to `prompt()`, in order. */
	readonly prompts: string[];
	/** Number of times `abort()` was called. */
	readonly abortCount: number;
	/** Current number of active event subscribers. */
	readonly listenerCount: number;
	/** Whether the session is mid-turn; settable so tests can drive the busy path. */
	isStreaming: boolean;
	/** Options passed to the most recent `prompt()` call. */
	readonly lastPromptOptions: { source?: string; streamingBehavior?: "steer" | "followUp" } | undefined;
}

export function createFakeSession(options: { sessionId?: string } = {}): FakeSession {
	const listeners = new Set<(event: SessionEvent) => void>();
	const prompts: string[] = [];
	let abortCount = 0;
	let promptHandler: ((text: string) => void) | undefined;
	let abortHandler: (() => void) | undefined;
	let lastPromptOptions: { source?: string; streamingBehavior?: "steer" | "followUp" } | undefined;

	const session: FakeSession = {
		sessionId: options.sessionId ?? "fake-session-id",
		isStreaming: false,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text, opts) {
			prompts.push(text);
			lastPromptOptions = opts;
			promptHandler?.(text);
		},
		async abort() {
			abortCount += 1;
			abortHandler?.();
		},
		emit(event) {
			for (const listener of [...listeners]) listener(event);
		},
		onPrompt(handler) {
			promptHandler = handler;
		},
		onAbort(handler) {
			abortHandler = handler;
		},
		get prompts() {
			return prompts;
		},
		get abortCount() {
			return abortCount;
		},
		get listenerCount() {
			return listeners.size;
		},
		get lastPromptOptions() {
			return lastPromptOptions;
		},
	};
	return session;
}
