/**
 * Ralph Type Definitions
 *
 * TypeScript types for PRD-driven development orchestration.
 */

/**
 * Story status
 */
export type StoryStatus = "pending" | "in_progress" | "completed" | "blocked";

/**
 * PRD status in the workflow lifecycle
 * - pending: PRD created but not started
 * - in_progress: PRD started, work in progress
 * - qa: All stories complete, ready for QA verification
 * - completed: Verified and done
 */
export type PRDStatus = "pending" | "in_progress" | "qa" | "completed";

/**
 * Story definition - a chunk of work within a PRD
 *
 * Story acceptance criteria live in the story file at `stories/<id>.md`
 * under the `## Acceptance Criteria` section. prd.json carries only
 * metadata + `promptPath` — the story file is the source of truth for
 * scope, deliverables, and acceptance criteria.
 */
export interface Story {
	/** Unique story identifier (e.g., S-01) */
	id: string;
	/** Story title */
	title: string;
	/** Relative path (from PRD dir) to the story markdown file */
	promptPath: string;
	/** Current status */
	status: StoryStatus;
	/** Priority 1-10 (lower = higher priority) */
	priority: number;
	/** Questions for user when blocked */
	questions: string[];
	/** User's answers to questions (parallel array to questions) */
	answers?: string[];
	/** Number of iterations attempted for this story (used to detect stuck stories) */
	iterationCount?: number;
	/**
	 * Git commit SHA captured when the story first transitioned pending → in_progress.
	 * Used by the per-story verifier to compute the diff of work done on this story.
	 */
	startCommit?: string;
}

/**
 * Last run information - captured on Ctrl+C or completion
 */
export interface LastRun {
	/** ISO timestamp */
	timestamp: string;
	/** Story ID that was being worked on */
	storyId: string;
	/** Reason for stopping */
	reason: "user_interrupted" | "completed" | "story_completed" | "blocked" | "error";
	/** Agent's summary of where it stopped */
	summary: string;
}

/**
 * Metrics tracked for a PRD
 */
export interface PRDMetrics {
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	iterations?: number;
}

/**
 * Product Requirements Document
 */
export interface PRD {
	name: string;
	description: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	stories: Story[];
	dependencies?: string[];
	/**
	 * True when QA has already failed for this PRD and the next completion
	 * should skip the full review pipeline for focused QA-fix work.
	 */
	qaCaughtIssue?: boolean;
	lastRun?: LastRun;
	metrics?: PRDMetrics;
}

/**
 * Provider variant configuration — a Ralph-owned LLM launch profile.
 * Each variant is a command + args pair Ralph can spawn directly.
 */
export interface ProviderVariantConfig {
	command: string;
	args: string[];
}

/**
 * QA platform declaration
 */
export interface QAPlatformConfig {
	/** Capability id whose ralph-qa.md should be injected. Omit for plain platforms. */
	plugin?: string;
}

/**
 * QA configuration
 */
export interface QAConfig {
	/** Instructions for project verification (e.g., "pnpm lint, pnpm typecheck must pass") */
	project_verification_instructions?: string;
	/** Max iterations for QA agent */
	qa_iterations?: number;
	/** Free-form QA instructions (URLs, credentials, context, etc.) */
	instructions?: string;
	/** Health check timeout in seconds (default: 30) */
	health_check_timeout?: number;
	/** Max healthcheck fix agent attempts (default: 3) */
	max_health_fix_attempts?: number;
	/** Platform declarations: e.g. platforms.web.plugin = "browser-testing" */
	platforms?: Record<string, QAPlatformConfig>;
}

/**
 * Scripts configuration - paths to lifecycle scripts
 */
export interface ScriptsConfig {
	setup?: string;
	start?: string;
	health_check?: string;
	teardown?: string;
}

/**
 * Issue found during QA
 */
export interface QAIssue {
	id: string;
	description: string;
	screenshot?: string;
	severity?: "critical" | "major" | "minor";
}

/**
 * Documentation configuration
 */
export interface DocsConfig {
	path: string;
	auto_update?: boolean;
	/** Provider variant name for documentation updates. Falls back to default_provider_variant. */
	provider_variant?: string;
}

/**
 * Per-story verification configuration
 */
export interface VerificationConfig {
	/**
	 * Provider variant name used by the per-story verifier.
	 * Defaults to "claude-haiku" when absent.
	 */
	story_verifier_provider_variant?: string;
}

/**
 * Review configuration for code review pipeline
 */
export interface ReviewConfig {
	enabled?: boolean;
	/** Provider variant for internal review prompts. Falls back to default_provider_variant. */
	provider_variant?: string;
	/** Provider variant for fixing review findings. Falls back to review.provider_variant → default_provider_variant. */
	fix_provider_variant?: string;
	/** Provider variant for the finalize step. Falls back to review.provider_variant → default_provider_variant. */
	finalize_provider_variant?: string;
	/** Provider variant for external review round, or "" to disable (default: "") */
	review_provider_variant?: string;
	finalize_enabled?: boolean;
	finalize_prompt?: string;
	first_review_agents?: string[];
	second_review_agents?: string[];
	max_fix_iterations?: number;
	todo_file?: string;
}

/**
 * A single finding from a review agent
 */
export interface ReviewFinding {
	severity: "critical" | "major" | "minor" | "suggestion";
	file: string;
	line?: number;
	issue: string;
	reviewer: string;
}

/**
 * Result of a single review round
 */
export interface ReviewRoundResult {
	reviewType: string;
	decision: "approve" | "request_changes";
	findings: ReviewFinding[];
}

/**
 * Swarm configuration for parallel PRD execution
 */
export interface SwarmConfig {
	worktree_parent?: string;
	panes_per_window?: number;
	pane_close_timeout?: number;
	worktree_create_cmd?: string;
	primary_branch?: string;
	/** Provider variant for merge operations. Falls back to default_provider_variant. */
	merge_provider_variant?: string;
}

/**
 * Ralph configuration
 */
export interface RalphConfig {
	/** Project name — used for state directory and session name */
	project_name: string;
	/** Default provider variant to use */
	default_provider_variant: string;
	/** Default max iterations */
	default_iterations: number;
	/** Available provider variants (Ralph-owned LLM launch profiles) */
	provider_variants: Record<string, ProviderVariantConfig>;
	/** Provider variant for verification prompt generation. Falls back to default_provider_variant. */
	verification_provider_variant?: string;
	/**
	 * Whether to run the per-story verifier after each story is marked completed.
	 * Default: true.
	 */
	per_story_verification?: boolean;
	/** Per-story verification settings */
	verification?: VerificationConfig;
	/** QA configuration */
	qa?: QAConfig;
	/** Scripts configuration - paths to lifecycle scripts */
	scripts?: ScriptsConfig;
	/** Documentation configuration */
	docs?: DocsConfig;
	/** Review configuration */
	review?: ReviewConfig;
	/** Swarm configuration for parallel PRD execution */
	swarm?: SwarmConfig;
}

/**
 * QA result for a single verification item
 */
export interface QAResult {
	item: string;
	passed: boolean;
	reason?: string;
	details?: string;
}

/**
 * Full QA report for a PRD
 */
export interface QAReport {
	prdName: string;
	timestamp: string;
	qaResults: QAResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
	};
	agentOutput?: string;
}

/**
 * Dependency information for a single PRD
 */
export interface DependencyInfo {
	name: string;
	status: PRDStatus;
	dependencies: string[];
	isComplete: boolean;
	canStart: boolean;
	unmetDependencies: string[];
}

/**
 * PRD summary for list operations
 */
export interface PRDSummary {
	name: string;
	status: PRDStatus;
	description: string;
	progress: {
		completed: number;
		total: number;
		inProgress: number;
		blocked: number;
	};
	canStart: boolean;
	hasBlockedStories: boolean;
	dependencies: string[];
	unmetDependencies: string[];
	startedAt?: string;
	completedAt?: string;
	metrics?: PRDMetrics;
}
