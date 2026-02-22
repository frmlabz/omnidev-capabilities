/**
 * Runner Module — Parallel PRD execution via worktrees + session backends
 *
 * Library-first: RunnerManager is the consumer-agnostic API.
 * CLI, web UI, or any consumer instantiates RunnerManager with a config
 * and a SessionBackend implementation.
 */

// Types
export type {
	RunnerConfig,
	RunStatus,
	RunInstance,
	StartOptions,
	TestOptions,
	MergeResult,
	ConflictReport,
	RecoverResult,
	RunnerState,
	PersistedRunInstance,
	PaneInfo,
	PaneOptions,
	SessionBackend,
} from "./types.js";

export { DEFAULT_RUNNER_CONFIG } from "./types.js";

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
	mergeWorktree,
	checkMergeConflicts,
	getMainWorktreePath,
	isMainWorktree,
	interpolateWorktreeCmd,
} from "./worktree.js";

// Runner state
export {
	loadRunnerState,
	saveRunnerState,
	upsertRun,
	updateRunStatus,
	removeRun,
	getRun,
	getAllRuns,
	reconcile,
} from "./state.js";

// Main API
export { RunnerManager, readWorktreePRD } from "./runner.js";
