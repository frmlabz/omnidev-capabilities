/**
 * Ralph Orchestrator Daemon Types
 */

/**
 * Daemon registration file schema
 * Location: ~/.local/state/ralph-orchestrator/daemons/<daemon-id>.json
 */
export interface DaemonRegistration {
	schemaVersion: 1;
	id: string;
	projectPath: string;
	projectName: string;
	host: string;
	port: number;
	pid: number;
	startedAt: string;
	lastHeartbeat: string;
}

/**
 * Standard API response envelope
 */
export interface ApiResponse<T> {
	ok: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
	};
}

/**
 * Daemon info response
 */
export interface DaemonInfo {
	id: string;
	projectPath: string;
	projectName: string;
	version: string;
	uptime: number;
}

/**
 * WebSocket event types (Daemon → Client)
 */
export type WebSocketEvent =
	| { type: "connected"; daemonId: string; projectName: string }
	| { type: "daemon:heartbeat"; timestamp: string }
	| { type: "prd:status"; prd: string; status: string; timestamp: string }
	| { type: "prd:log"; prd: string; line: string; timestamp: string }
	| { type: "prd:progress"; prd: string; story: string; iteration: number };

/**
 * WebSocket command types (Client → Daemon)
 */
export type WebSocketCommand =
	| { type: "subscribe"; prds: string[] }
	| { type: "unsubscribe"; prds: string[] };

/**
 * Daemon configuration options
 */
export interface DaemonConfig {
	host: string;
	port?: number;
	projectPath: string;
}
