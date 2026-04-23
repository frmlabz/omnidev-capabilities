/**
 * Ralph Library - Core functionality for PRD-driven development
 *
 * This module exports all the core functionality used by both the CLI and the daemon.
 * It provides a clean API for:
 * - State management (PRDs, stories, progress)
 * - Orchestration (running agents, iteration loops)
 * - QA (verification, QA automation)
 * - Configuration loading
 */

// High-level API (structured results for CLI and daemon)
export {
	canTransition,
	getActions,
	getPRDState,
	type RunOptions,
	runQA,
	startDevelopment,
} from "./api.js";
// Core - Config (Result-based API)
export {
	getProviderVariantConfig,
	getQAConfig,
	getReviewConfig,
	getScriptsConfig,
	getSwarmConfig,
	hasProviderVariant,
	loadConfig,
	type ResolvedReviewProviderVariants,
	resolveReviewProviderVariants,
} from "./core/config.js";
// Core - Logger
export {
	ConsoleOutput,
	configureLogger,
	createLogger,
	EventOutput,
	FileOutput,
	getLogger,
	type LogContext,
	type LogEntry,
	Logger,
	type LogLevel,
	type LogOutput,
	MemoryOutput,
} from "./core/logger.js";
// Core - Paths
export {
	atomicWrite,
	ensureStateDirs,
	getPrdsDir,
	getProjectKey,
	getStateDir,
	getStatusDir,
	getSwarmStatePath,
	getXdgStateHome,
	validateProjectName,
} from "./core/paths.js";
// Core - PRD Store
export {
	createStore,
	getDefaultStore,
	PRDStore,
} from "./core/prd-store.js";
// Core - State Machine
export {
	type DisplayState,
	DisplayStateMachine,
	PRDStateMachine,
	StoryStateMachine,
} from "./core/state-machine.js";
// Documentation
export {
	applyDocumentationUpdates,
	DOCUMENTATION_OUTPUT_FORMAT,
	DOCUMENTATION_PRINCIPLES,
	type DocFile,
	type DocumentationContext,
	findDocFiles,
	generateDocumentationUpdatePrompt,
	parseDocumentationUpdates,
	updateDocumentation,
} from "./documentation.js";
// Event-based API (for daemon integration)
export {
	createOrchestrator,
	Orchestrator,
	type OrchestratorEvent,
	type OrchestratorOptions,
} from "./events.js";
// Orchestration - Agent Executor
export {
	AgentExecutor,
	type AgentResult,
	createAgentExecutor,
	getAgentExecutor,
	type RunOptions as AgentRunOptions,
} from "./orchestration/agent-runner.js";
// Orchestration - Engine
export {
	createEngine,
	type DevelopmentResult,
	type EngineContext,
	type EngineEvent,
	OrchestrationEngine,
	type QARunResult,
	type RunOptions as EngineRunOptions,
} from "./orchestration/engine.js";

// Orchestration - Review Engine
export { ReviewEngine } from "./orchestration/review-engine.js";

// Prompt generation
export { generateFindingsExtractionPrompt, generatePrompt } from "./prompt.js";
// QA
export {
	detectQAResult,
	extractIssues,
	generateQAPluginPrompt,
	generateQAPrompt,
	generateQARetestPrompt,
	getPreviousFailures,
	parseQAReport,
	resolveQAPluginPath,
	saveQAReport,
} from "./qa.js";
// Result types
export {
	computeDisplayState,
	type ErrorCode,
	ErrorCodes,
	err,
	getAvailableActions,
	isValidTransition,
	ok,
	type PRDDisplayState,
	type QAStartResult,
	type Result,
	type StartResult,
	type StateResult,
	type TransitionResult,
} from "./results.js";
// Review prompt generation
export {
	generateExternalReviewPrompt,
	generateFinalizePrompt,
	generateFixPrompt,
	generateReviewPrompt,
	parseReviewResult,
} from "./review-prompt.js";
// Schemas (Zod validation)
export {
	DependencyInfoSchema,
	type DependencyInfoZ,
	DocsConfigSchema,
	type DocsConfigZ,
	LastRunSchema,
	type LastRunZ,
	PRDMetricsSchema,
	type PRDMetricsZ,
	PRDSchema,
	PRDStatusSchema,
	type PRDStatusZ,
	PRDSummarySchema,
	type PRDSummaryZ,
	type PRDZ,
	ProviderVariantConfigSchema,
	type ProviderVariantConfigZ,
	QAConfigSchema,
	type QAConfigZ,
	QAIssueSchema,
	type QAIssueZ,
	QAPlatformConfigSchema,
	type QAPlatformConfigZ,
	QAReportSchema,
	type QAReportZ,
	QAResultSchema,
	type QAResultZ,
	RalphConfigSchema,
	type RalphConfigZ,
	ReviewConfigSchema,
	type ReviewConfigZ,
	ScriptsConfigSchema,
	type ScriptsConfigZ,
	StorySchema,
	StoryStatusSchema,
	type StoryStatusZ,
	type StoryZ,
	SwarmConfigSchema,
	type SwarmConfigZ,
	validatePRD,
	validateRalphConfig,
	validateStory,
} from "./schemas.js";
// Legacy State management (for backward compatibility)
export {
	addFixStory,
	appendProgress,
	appendToFindings,
	buildDependencyGraph,
	canStartPRD,
	clearQAResults,
	ensureDirectories,
	extractAndSaveFindings,
	extractFindings,
	findPRDLocation,
	getNextFixStoryId,
	getNextStory,
	getPRD,
	getPRDSummaries,
	getProgress,
	getQAResultsDir,
	getSpec,
	getStoryFilePath,
	getUnmetDependencies,
	hasBlockedStories,
	hasPRDFile,
	isPRDComplete,
	isPRDCompleteOrArchived,
	listPRDs,
	listPRDsByStatus,
	markPRDCompleted,
	markPRDStarted,
	movePRD,
	readStoryAcceptanceCriteria,
	savePRD,
	unblockStory,
	updateLastRun,
	updateMetrics,
	updatePRD,
	updateStoryStatus,
} from "./state.js";
// Swarm module — parallel PRD execution via worktrees + session backends
export {
	branchExists,
	createWorktree,
	DEFAULT_SWARM_CONFIG,
	getAllRuns,
	getCurrentBranch,
	getMainWorktreePath,
	getRun,
	hasUncommittedChanges,
	isMainWorktree,
	listWorktrees,
	// Swarm state
	loadSwarmState,
	type MergeOptions,
	type MergeResult,
	type PaneInfo,
	type PaneOptions,
	type PersistedRunInstance,
	type QAOptions,
	type RecoverResult,
	type RunInstance,
	// Types
	type RunStatus,
	readWorktreePRD,
	reconcile,
	removeRun as removeRunInstance,
	removeWorktree,
	resolveWorktreePath,
	type SessionBackend,
	type StartOptions,
	// Main API
	SwarmManager,
	type SwarmState,
	saveSwarmState,
	// Session backends
	TmuxSessionBackend,
	updateRunStatus,
	upsertRun,
	// Worktree operations
	type WorktreeInfo,
} from "./swarm/index.js";
// Types
export type {
	DependencyInfo,
	DocsConfig,
	LastRun,
	PRD,
	PRDMetrics,
	PRDStatus,
	PRDSummary,
	ProviderVariantConfig,
	QAConfig,
	QAIssue,
	QAPlatformConfig,
	QAReport,
	QAResult,
	RalphConfig,
	ReviewConfig,
	ReviewFinding,
	ReviewRoundResult,
	ScriptsConfig,
	Story,
	StoryStatus,
	SwarmConfig,
} from "./types.js";
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
