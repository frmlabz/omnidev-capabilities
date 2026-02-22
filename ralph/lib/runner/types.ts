/**
 * Runner Type Definitions
 *
 * Types for the parallel PRD execution layer using git worktrees
 * and pluggable session backends.
 */

import type { Result } from "../results.js";

/**
 * Runner configuration from [ralph.runner] in omni.toml
 */
export interface RunnerConfig {
	/** Relative path to parent directory for worktrees (default: "..") */
	worktree_parent: string;
	/** Max panes per tmux window (default: 4) */
	panes_per_window: number;
	/** Seconds before auto-closing a completed pane (default: 30) */
	pane_close_timeout: number;
	/** Custom command to create worktree (runs inside pane). Placeholders: {name}, {path}, {branch} */
	worktree_create_cmd?: string;
}

/**
 * Default runner configuration values
 */
export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
	worktree_parent: "..",
	panes_per_window: 4,
	pane_close_timeout: 30,
};

/**
 * Run status for a single PRD instance
 */
export type RunStatus = "running" | "completed" | "failed" | "stopped" | "stale";

/**
 * A single running PRD instance
 */
export interface RunInstance {
	/** PRD name */
	prdName: string;
	/** Absolute path to the worktree */
	worktree: string;
	/** Git branch name */
	branch: string;
	/** Session backend pane identifier */
	paneId: string;
	/** ISO timestamp when started */
	startedAt: string;
	/** Current run status */
	status: RunStatus;
	/** Window ID in session backend */
	windowId?: string;
}

/**
 * Options for starting a PRD run
 */
export interface StartOptions {
	/** Override the agent to use */
	agent?: string;
}

/**
 * Options for test runs
 */
export interface TestOptions {
	/** Override the agent to use */
	agent?: string;
}

/**
 * Result of a merge operation
 */
export interface MergeResult {
	/** PRD that was merged */
	prdName: string;
	/** Merge commit SHA */
	commitSha: string;
	/** Files changed in the merge */
	filesChanged: string[];
	/** Whether there were conflicts (only if merge failed) */
	hadConflicts: boolean;
}

/**
 * Report of merge conflicts for a PRD
 */
export interface ConflictReport {
	/** PRD name */
	prdName: string;
	/** Branch name */
	branch: string;
	/** Files with conflicts */
	conflictFiles: string[];
	/** Human-readable summary */
	summary: string;
}

/**
 * Result of a recover operation
 */
export interface RecoverResult {
	/** Instances that were successfully recovered */
	recovered: RunInstance[];
	/** Instances that are orphaned (worktree exists, no session) */
	orphaned: Array<{ prdName: string; worktree: string; branch: string }>;
	/** Instances that were cleaned up (stale state, nothing on disk) */
	cleaned: string[];
}

/**
 * Persisted runner state (runner.json)
 */
export interface RunnerState {
	/** Session name */
	session: string;
	/** Active run instances keyed by PRD name */
	runs: Record<string, PersistedRunInstance>;
}

/**
 * Minimal run instance data persisted to disk
 */
export interface PersistedRunInstance {
	/** Absolute path to the worktree */
	worktree: string;
	/** Git branch name */
	branch: string;
	/** Session backend pane identifier */
	paneId: string;
	/** ISO timestamp when started */
	startedAt: string;
	/** Current run status */
	status: RunStatus;
	/** Window ID in session backend */
	windowId?: string;
}

/**
 * Information about a session pane
 */
export interface PaneInfo {
	/** Unique pane identifier (e.g., "session:0.1") */
	paneId: string;
	/** Window identifier */
	windowId: string;
	/** Pane title / name */
	title: string;
	/** Whether the pane process is alive */
	alive: boolean;
}

/**
 * Options for creating a pane
 */
export interface PaneOptions {
	/** Desired pane title */
	title: string;
	/** Initial command to run (optional) */
	command?: string;
	/** Preferred window ID (optional — backend picks if not specified) */
	windowId?: string;
}

/**
 * Session backend abstraction
 *
 * Tmux is one implementation. A web UI might use PTY over WebSocket instead.
 */
export interface SessionBackend {
	/** Backend name (e.g., "tmux", "pty-ws") */
	readonly name: string;

	// --- Session management ---
	ensureSession(name: string): Promise<Result<void>>;
	sessionExists(name: string): Promise<Result<boolean>>;
	destroySession(name: string): Promise<Result<void>>;

	// --- Pane management ---
	createPane(session: string, options: PaneOptions): Promise<Result<PaneInfo>>;
	destroyPane(paneId: string): Promise<Result<void>>;
	sendCommand(paneId: string, command: string): Promise<Result<void>>;
	sendInterrupt(paneId: string): Promise<Result<void>>;

	// --- Pane layout ---
	rebalance(session: string, windowId?: string): Promise<Result<void>>;
	getPaneCount(session: string, windowId?: string): Promise<Result<number>>;

	// --- Query ---
	listPanes(session: string): Promise<Result<PaneInfo[]>>;
	isPaneAlive(paneId: string): Promise<Result<boolean>>;

	// --- Focus (interactive — CLI-only, web UI would ignore) ---
	focusPane(paneId: string): Promise<Result<void>>;

	// --- Capabilities ---
	isAvailable(): Promise<boolean>;
}
