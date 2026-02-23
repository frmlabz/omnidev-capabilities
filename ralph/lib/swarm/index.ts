/**
 * Swarm Module — Parallel PRD execution via worktrees + session backends
 *
 * Library-first: SwarmManager is the consumer-agnostic API.
 * CLI, web UI, or any consumer instantiates SwarmManager with a config
 * and a SessionBackend implementation.
 */

// Types
export type {
	SwarmConfig,
	RunStatus,
	RunInstance,
	StartOptions,
	TestOptions,
	MergeResult,
	MergeOptions,
	RecoverResult,
	SwarmState,
	PersistedRunInstance,
	PaneInfo,
	PaneOptions,
	SessionBackend,
} from "./types.js";

export { DEFAULT_SWARM_CONFIG } from "./types.js";

// Session backends
export { TmuxSessionBackend } from "./session-tmux.js";

// Worktree operations
export {
	type WorktreeInfo,
	type WorktreeCmdVars,
	getCurrentBranch,
	branchExists,
	listWorktrees,
	resolveWorktreePath,
	createWorktree,
	removeWorktree,
	hasUncommittedChanges,
	getMainWorktreePath,
	isMainWorktree,
	interpolateWorktreeCmd,
} from "./worktree.js";

// Swarm state
export {
	loadSwarmState,
	saveSwarmState,
	upsertRun,
	updateRunStatus,
	removeRun,
	getRun,
	getAllRuns,
	reconcile,
} from "./state.js";

// Main API
export { SwarmManager, readWorktreePRD } from "./swarm.js";
