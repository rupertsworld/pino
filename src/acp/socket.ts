/**
 * ACP unix-socket listener lifecycle.
 *
 * Opens `$PINO_STATE_DIR/acp.sock` alongside the TUI and exposes the live
 * `AgentSession` over ACP. Designed to never destabilise the host:
 *  - stale socket files (no listener) are unlinked and rebound;
 *  - if another live pino already holds the socket, we skip (no throw);
 *  - socket/ACP errors are isolated and logged quietly to stderr;
 *  - the socket file is removed on close and best-effort on process exit.
 */

import { connect, createServer, type Server } from "node:net";
import { unlink, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { PinoAcpAgent, type PinoAgentSession } from "./agent.ts";

export interface AcpSocketServer {
	/** Resolved socket path. */
	readonly path: string;
	/** True when another live listener held the socket and we stood down. */
	readonly skipped: boolean;
	/** Stop listening and remove the socket file (no-op when skipped). */
	close(): Promise<void>;
}

export function acpSocketPath(stateDir: string): string {
	return join(stateDir, "acp.sock");
}

function logError(message: string): void {
	process.stderr.write(`[pino acp] ${message}\n`);
}

/** Resolve true if something is actively listening on the socket path. */
function isListenerAlive(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect(path);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => {
			probe.destroy();
			resolve(false);
		});
	});
}

export async function startAcpSocketServer(session: PinoAgentSession, stateDir: string): Promise<AcpSocketServer> {
	const path = acpSocketPath(stateDir);

	if (await isListenerAlive(path)) {
		logError(`a pino ACP listener is already active at ${path}; skipping (single-pino only).`);
		return { path, skipped: true, close: async () => {} };
	}

	// Either nothing exists or it's a stale file/socket — clear it before binding.
	await new Promise<void>((resolve) => unlink(path, () => resolve()));

	const server = createServer((socket) => {
		socket.on("error", (error) => logError(`connection error: ${error.message}`));
		try {
			const stream = acp.ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket));
			// Each connection gets its own agent bound to the one live session.
			let agent: PinoAcpAgent | undefined;
			new acp.AgentSideConnection((conn) => {
				agent = new PinoAcpAgent(conn, session);
				return agent;
			}, stream);
			// Drop this connection's session subscription when the socket closes,
			// so reconnecting clients don't accumulate dead subscribers.
			socket.once("close", () => agent?.dispose());
		} catch (error) {
			logError(`failed to attach connection: ${error instanceof Error ? error.message : String(error)}`);
			socket.destroy();
		}
	});

	server.on("error", (error) => logError(`server error: ${error.message}`));

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(path, () => {
			server.off("error", onError);
			resolve();
		});
	});

	const cleanupOnExit = () => {
		try {
			unlinkSync(path);
		} catch {
			// best effort
		}
	};
	process.once("exit", cleanupOnExit);

	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		process.removeListener("exit", cleanupOnExit);
		await closeServer(server);
		await new Promise<void>((resolve) => unlink(path, () => resolve()));
	};

	return { path, skipped: false, close };
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}
