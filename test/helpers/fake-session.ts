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
}

export function createFakeSession(options: { sessionId?: string } = {}): FakeSession {
	const listeners = new Set<(event: SessionEvent) => void>();
	const prompts: string[] = [];
	let abortCount = 0;
	let promptHandler: ((text: string) => void) | undefined;
	let abortHandler: (() => void) | undefined;

	const session: FakeSession = {
		sessionId: options.sessionId ?? "fake-session-id",
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text) {
			prompts.push(text);
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
	};
	return session;
}
