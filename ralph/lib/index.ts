/**
 * Ralph Library - Core functionality for PRD-driven development
 *
 * This module exports all the core functionality used by both the CLI and the daemon.
 * It provides a clean API for:
 * - State management (PRDs, stories, progress)
 * - Orchestration (running agents, iteration loops)
 * - Testing (QA automation, verification)
 * - Configuration loading
 */

// Types
export type {
	AgentConfig,
	DependencyInfo,
	DocsConfig,
	LastRun,
	PRD,
	PRDMetrics,
	PRDStatus,
	PRDSummary,
	RalphConfig,
	ReviewConfig,
	ReviewFinding,
	ReviewRoundResult,
	SwarmConfig,
	ScriptsConfig,
	Story,
	StoryStatus,
	TestingConfig,
	TestIssue,
	TestReport,
	TestResult,
} from "./types.js";

// Schemas (Zod validation)
export {
	StoryStatusSchema,
	PRDStatusSchema,
	StorySchema,
	LastRunSchema,
	PRDMetricsSchema,
	PRDSchema,
	AgentConfigSchema,
	TestingConfigSchema,
	ScriptsConfigSchema,
	DocsConfigSchema,
	ReviewConfigSchema,
	SwarmConfigSchema,
	RalphConfigSchema,
	TestResultSchema,
	TestReportSchema,
	TestIssueSchema,
	DependencyInfoSchema,
	PRDSummarySchema,
	validatePRD,
	validateStory,
	validateRalphConfig,
	type StoryStatusZ,
	type PRDStatusZ,
	type StoryZ,
	type LastRunZ,
	type PRDMetricsZ,
	type PRDZ,
	type AgentConfigZ,
	type TestingConfigZ,
	type ScriptsConfigZ,
	type DocsConfigZ,
	type ReviewConfigZ,
	type SwarmConfigZ,
	type RalphConfigZ,
	type TestResultZ,
	type TestReportZ,
	type TestIssueZ,
	type DependencyInfoZ,
	type PRDSummaryZ,
} from "./schemas.js";

// Core - State Machine
export {
	PRDStateMachine,
	StoryStateMachine,
	DisplayStateMachine,
	type DisplayState,
} from "./core/state-machine.js";

// Core - PRD Store
export {
	PRDStore,
	getDefaultStore,
	createStore,
} from "./core/prd-store.js";

// Core - Paths
export {
	validateProjectName,
	getProjectKey,
	getXdgStateHome,
	getStateDir,
	getPrdsDir,
	getStatusDir,
	getSwarmStatePath,
	ensureStateDirs,
	atomicWrite,
} from "./core/paths.js";

// Core - Config (Result-based API)
export {
	loadConfig,
	getAgentConfig,
	hasAgent,
	getTestingConfig,
	getScriptsConfig,
	getReviewConfig,
	getSwarmConfig,
	resolveReviewAgents,
	type ResolvedReviewAgents,
} from "./core/config.js";

// Core - Logger
export {
	type LogLevel,
	type LogContext,
	type LogEntry,
	type LogOutput,
	ConsoleOutput,
	FileOutput,
	EventOutput,
	MemoryOutput,
	Logger,
	getLogger,
	configureLogger,
	createLogger,
} from "./core/logger.js";

// Orchestration - Agent Executor
export {
	type RunOptions as AgentRunOptions,
	type AgentResult,
	AgentExecutor,
	getAgentExecutor,
	createAgentExecutor,
} from "./orchestration/agent-runner.js";

// Orchestration - Engine
export {
	type EngineContext,
	type EngineEvent,
	type RunOptions as EngineRunOptions,
	type DevelopmentResult,
	type TestRunResult,
	OrchestrationEngine,
	createEngine,
} from "./orchestration/engine.js";

// Legacy State management (for backward compatibility)
export {
	addFixStory,
	appendProgress,
	appendToFindings,
	buildDependencyGraph,
	canStartPRD,
	clearTestResults,
	ensureDirectories,
	extractAndSaveFindings,
	extractFindings,
	findPRDLocation,
	hasPRDFile,
	getNextFixStoryId,
	getNextStory,
	getPRD,
	getPRDSummaries,
	getProgress,
	getSpec,
	getTestResultsDir,
	getUnmetDependencies,
	hasBlockedStories,
	isPRDComplete,
	isPRDCompleteOrArchived,
	listPRDs,
	listPRDsByStatus,
	markPRDCompleted,
	markPRDStarted,
	movePRD,
	savePRD,
	unblockStory,
	updateLastRun,
	updateMetrics,
	updatePRD,
	updateStoryStatus,
} from "./state.js";

// Orchestration - Review Engine
export { ReviewEngine } from "./orchestration/review-engine.js";

// Prompt generation
export { generateFindingsExtractionPrompt, generatePrompt } from "./prompt.js";

// Review prompt generation
export {
	generateReviewPrompt,
	generateFixPrompt,
	generateExternalReviewPrompt,
	generateFinalizePrompt,
	parseReviewResult,
} from "./review-prompt.js";

// Verification
export {
	generateSimpleVerification,
	generateVerification,
	generateVerificationPrompt,
	getVerification,
	getVerificationPath,
	hasVerification,
	saveVerification,
} from "./verification.js";

// Testing
export {
	detectTestResult,
	extractIssues,
	generateTestPrompt,
	generateRetestPrompt,
	getPreviousFailures,
	parseTestReport,
	saveTestReport,
} from "./testing.js";

// Event-based API (for daemon integration)
export {
	createOrchestrator,
	Orchestrator,
	type OrchestratorEvent,
	type OrchestratorOptions,
} from "./events.js";

// High-level API (structured results for CLI and daemon)
export {
	getPRDState,
	startDevelopment,
	runTests,
	getActions,
	canTransition,
	type RunOptions,
} from "./api.js";

// Documentation
export {
	DOCUMENTATION_PRINCIPLES,
	DOCUMENTATION_OUTPUT_FORMAT,
	findDocFiles,
	generateDocumentationUpdatePrompt,
	parseDocumentationUpdates,
	applyDocumentationUpdates,
	updateDocumentation,
	type DocFile,
	type DocumentationContext,
} from "./documentation.js";

// Result types
export {
	type Result,
	type StartResult,
	type TestResult as TestingResult,
	type StateResult,
	type TransitionResult,
	type PRDDisplayState,
	type ErrorCode,
	ok,
	err,
	ErrorCodes,
	computeDisplayState,
	isValidTransition,
	getAvailableActions,
} from "./results.js";

// Swarm module — parallel PRD execution via worktrees + session backends
export {
	// Main API
	SwarmManager,
	readWorktreePRD,
	// Session backends
	TmuxSessionBackend,
	// Types
	type RunStatus,
	type RunInstance,
	type StartOptions,
	type TestOptions,
	type MergeResult,
	type MergeOptions,
	type RecoverResult,
	type SwarmState,
	type PersistedRunInstance,
	type PaneInfo,
	type PaneOptions,
	type SessionBackend,
	DEFAULT_SWARM_CONFIG,
	// Worktree operations
	type WorktreeInfo,
	getCurrentBranch,
	branchExists,
	listWorktrees,
	resolveWorktreePath,
	createWorktree,
	removeWorktree,
	hasUncommittedChanges,
	getMainWorktreePath,
	isMainWorktree,
	// Swarm state
	loadSwarmState,
	saveSwarmState,
	upsertRun,
	updateRunStatus,
	removeRun as removeRunInstance,
	getRun,
	getAllRuns,
	reconcile,
} from "./swarm/index.js";
