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
 * - testing: All stories complete, ready for verification
 * - completed: Verified and done
 */
export type PRDStatus = "pending" | "in_progress" | "testing" | "completed";

/**
 * Story definition - a chunk of work within a PRD
 */
export interface Story {
	/** Unique story identifier (e.g., US-001) */
	id: string;
	/** Story title */
	title: string;
	/** Verifiable acceptance criteria for this chunk */
	acceptanceCriteria: string[];
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
	/** Total tokens used (input + output) */
	totalTokens?: number;
	/** Total input tokens */
	inputTokens?: number;
	/** Total output tokens */
	outputTokens?: number;
	/** Number of agent iterations run */
	iterations?: number;
}

/**
 * Product Requirements Document
 */
export interface PRD {
	/** PRD name (unique identifier, matches folder name) */
	name: string;
	/** Description of the feature */
	description: string;
	/** ISO timestamp of creation */
	createdAt: string;
	/** ISO timestamp when work first began */
	startedAt?: string;
	/** ISO timestamp when PRD was completed */
	completedAt?: string;
	/** List of stories (work chunks) */
	stories: Story[];
	/** PRD names that must be completed before this one can start */
	dependencies?: string[];
	/** Last run information (set on Ctrl+C or completion) */
	lastRun?: LastRun;
	/** Tracked metrics */
	metrics?: PRDMetrics;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
	/** Command to spawn the agent */
	command: string;
	/** Arguments for the agent command */
	args: string[];
}

/**
 * Testing configuration
 */
export interface TestingConfig {
	/** Instructions for project verification (e.g., "pnpm lint, pnpm typecheck must pass") */
	project_verification_instructions?: string;
	/** Max iterations for test agent */
	test_iterations?: number;
	/** Enable web testing with Playwriter */
	web_testing_enabled?: boolean;
	/** Free-form instructions for testing (URLs, credentials, context, etc.) */
	instructions?: string;
	/** Health check timeout in seconds (default: 30) */
	health_check_timeout?: number;
	/** Max healthcheck fix agent attempts (default: 3) */
	max_health_fix_attempts?: number;
}

/**
 * Scripts configuration - paths to lifecycle scripts
 */
export interface ScriptsConfig {
	/** Path to setup script (runs before testing) */
	setup?: string;
	/** Path to start script (starts dev server) */
	start?: string;
	/** Path to health check script (polls until ready) */
	health_check?: string;
	/** Path to teardown script (cleanup after testing) */
	teardown?: string;
}

/**
 * Issue found during testing
 */
export interface TestIssue {
	/** Issue identifier */
	id: string;
	/** Description of the issue */
	description: string;
	/** Screenshot path if available */
	screenshot?: string;
	/** Severity level */
	severity?: "critical" | "major" | "minor";
}

/**
 * Documentation configuration
 */
export interface DocsConfig {
	/** Path to documentation directory (relative to project root) */
	path: string;
	/** Whether to automatically update docs on PRD completion (default: true) */
	auto_update?: boolean;
}

/**
 * Review configuration for code review pipeline
 */
export interface ReviewConfig {
	/** Whether review is enabled (default: true) */
	enabled?: boolean;
	/** Review agent name from [ralph.agents.*] for external review, or "" to disable (default: "") */
	review_agent?: string;
	/** Whether the finalize step is enabled (default: false) */
	finalize_enabled?: boolean;
	/** Custom prompt for the finalize step */
	finalize_prompt?: string;
	/** Agent types for the first review round (default: quality, implementation, testing, simplification, documentation) */
	first_review_agents?: string[];
	/** Agent types for the second review round (default: quality, implementation) */
	second_review_agents?: string[];
	/** Max fix iterations per review phase (default: 3) */
	max_fix_iterations?: number;
}

/**
 * A single finding from a review agent
 */
export interface ReviewFinding {
	/** Severity level */
	severity: "critical" | "major" | "minor" | "suggestion";
	/** File path */
	file: string;
	/** Line number (if available) */
	line?: number;
	/** Description of the issue */
	issue: string;
	/** Which reviewer produced this finding */
	reviewer: string;
}

/**
 * Result of a single review round
 */
export interface ReviewRoundResult {
	/** Which review type produced this result */
	reviewType: string;
	/** Overall decision */
	decision: "approve" | "request_changes";
	/** Individual findings */
	findings: ReviewFinding[];
}

/**
 * Ralph configuration
 */
export interface RalphConfig {
	/** Default agent to use */
	default_agent: string;
	/** Default max iterations */
	default_iterations: number;
	/** Available agents */
	agents: Record<string, AgentConfig>;
	/** Testing configuration */
	testing?: TestingConfig;
	/** Scripts configuration - paths to lifecycle scripts */
	scripts?: ScriptsConfig;
	/** Documentation configuration */
	docs?: DocsConfig;
	/** Review configuration */
	review?: ReviewConfig;
}

/**
 * Test result for a single verification item
 */
export interface TestResult {
	/** The item being tested */
	item: string;
	/** Whether the test passed */
	passed: boolean;
	/** Reason for failure (if failed) */
	reason?: string;
	/** Additional details */
	details?: string;
}

/**
 * Full test report for a PRD
 */
export interface TestReport {
	/** PRD name */
	prdName: string;
	/** When the test was run */
	timestamp: string;
	/** Individual test results */
	testResults: TestResult[];
	/** Summary stats */
	summary: {
		total: number;
		passed: number;
		failed: number;
	};
	/** Raw agent output */
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
