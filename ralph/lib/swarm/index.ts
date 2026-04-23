/**
 * Swarm Module — Parallel PRD execution via worktrees + session backends
 *
 * Library-first: SwarmManager is the consumer-agnostic API.
 * CLI, web UI, or any consumer instantiates SwarmManager with a config
 * and a SessionBackend implementation.
 */

// Session backends
export { TmuxSessionBackend } from "./session-tmux.js";
// Swarm state
export {
	getAllRuns,
	getRun,
	loadSwarmState,
	reconcile,
	removeRun,
	saveSwarmState,
	updateRunStatus,
	upsertRun,
} from "./state.js";
// Main API
export { readWorktreePRD, SwarmManager } from "./swarm.js";
// Types
export type {
	MergeOptions,
	MergeResult,
	PaneInfo,
	PaneOptions,
	PersistedRunInstance,
	QAOptions,
	RecoverResult,
	RunInstance,
	RunStatus,
	SessionBackend,
	StartOptions,
	SwarmConfig,
	SwarmState,
} from "./types.js";
export { DEFAULT_SWARM_CONFIG } from "./types.js";
// Worktree operations
export {
	branchExists,
	createWorktree,
	getCurrentBranch,
	getMainWorktreePath,
	hasUncommittedChanges,
	interpolateWorktreeCmd,
	isMainWorktree,
	listWorktrees,
	removeWorktree,
	resolveWorktreePath,
	type WorktreeCmdVars,
	type WorktreeInfo,
} from "./worktree.js";
