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
 * Worktree summary for API responses
 */
export interface WorktreeSummary {
	name: string;
	path: string;
	branch: string;
	isMain: boolean;
	prdName: string | null;
	runningCommands: string[]; // Currently executing command IDs
}

/**
 * Command execution status
 */
export type CommandStatus = "running" | "success" | "failed";

/**
 * Command execution record
 */
export interface CommandExecution {
	id: string;
	worktree: string;
	commandKey: string; // e.g., "lint", "test"
	label: string;
	command: string; // Actual command string
	status: CommandStatus;
	exitCode?: number;
	startedAt: string;
	endedAt?: string;
}

/**
 * PRD display state for UI
 * Combines PRD status + worktree existence
 */
export type PRDDisplayState = "pending" | "in_progress" | "testing" | "completed";

/**
 * Enriched PRD summary with display state
 */
export interface EnrichedPRDSummary {
	name: string;
	description: string;
	status: string; // Original status from ralph lib
	displayState: PRDDisplayState; // Computed for UI
	storyCount: number;
	completedStories: number;
	blockedStories: number;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	worktree: string | null;
	worktreePath: string;
	isRunning: boolean;
	runningOperation?: string;
}

/**
 * WebSocket event types (Daemon → Client)
 */
export type WebSocketEvent =
	| { type: "connected"; daemonId: string; projectName: string }
	| { type: "daemon:heartbeat"; timestamp: string }
	| { type: "prd:status"; prd: string; status: string; timestamp: string }
	| { type: "prd:log"; prd: string; line: string; timestamp: string }
	| { type: "prd:progress"; prd: string; story: string; iteration: number; max: number }
	| { type: "prd:state_change"; prd: string; from: string; to: string; timestamp: string }
	| {
			type: "prd:health_check";
			prd: string;
			status: "start" | "progress" | "passed" | "failed";
			elapsed?: number;
			timeout?: number;
			error?: string;
			timestamp: string;
	  }
	| { type: "prd:complete"; prd: string; result: string; message: string; timestamp: string }
	| {
			type: "worktree:command:start";
			worktree: string;
			commandId: string;
			commandKey: string;
			timestamp: string;
	  }
	| {
			type: "worktree:command:log";
			worktree: string;
			commandId: string;
			line: string;
			timestamp: string;
	  }
	| {
			type: "worktree:command:end";
			worktree: string;
			commandId: string;
			status: CommandStatus;
			exitCode: number;
			timestamp: string;
	  }
	| { type: "worktree:created"; worktree: string; prdName: string; timestamp: string }
	| { type: "worktree:merged"; worktree: string; prdName: string; timestamp: string }
	| { type: "daemon:shutdown"; timestamp: string };

/**
 * WebSocket command types (Client → Daemon)
 */
export type WebSocketCommand =
	| { type: "subscribe"; prds: string[] }
	| { type: "unsubscribe"; prds: string[] }
	| { type: "subscribe:worktree"; worktrees: string[] }
	| { type: "unsubscribe:worktree"; worktrees: string[] };

/**
 * Daemon startup options
 */
export interface DaemonStartupOptions {
	host: string;
	port?: number;
	projectPath: string;
}
