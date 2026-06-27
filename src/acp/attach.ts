/**
 * `pino acp-attach`: a dumb stdio <-> unix-socket relay.
 *
 * Television spawns this as `TELEVISION_ACP_COMMAND="pino acp-attach"`. It does
 * NOT start a pino runtime — it just pipes raw bytes (newline-delimited ACP
 * JSON passes through untouched) between this process's stdio and the live
 * pino's ACP socket. Exits 0 when either side closes; non-zero if the socket
 * connection fails (so the host sees the launch failure).
 */

import { connect } from "node:net";

import { acpSocketPath } from "./socket.ts";

export function runAcpAttach(stateDir: string): Promise<number> {
	const path = acpSocketPath(stateDir);
	return new Promise((resolve) => {
		const socket = connect(path);
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			resolve(code);
		};

		socket.once("error", (error) => {
			process.stderr.write(`pino acp-attach: cannot connect to ${path}: ${error.message}\n`);
			finish(1);
		});

		socket.once("connect", () => {
			process.stdin.pipe(socket);
			socket.pipe(process.stdout);
			// Either side closing ends the relay.
			socket.once("close", () => finish(0));
			process.stdin.once("end", () => socket.end());
			socket.once("error", () => finish(1));
		});
	});
}
