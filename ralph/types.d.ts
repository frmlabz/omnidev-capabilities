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
 * Product Requirements Document
 */
export interface PRD {
	/** PRD name (unique identifier, matches folder name) */
	name: string;
	/** Description of the feature */
	description: string;
	/** ISO timestamp of creation */
	createdAt: string;
	/** List of stories (work chunks) */
	stories: Story[];
	/** PRD names that must be completed before this one can start */
	dependencies?: string[];
	/** Last run information (set on Ctrl+C or completion) */
	lastRun?: LastRun;
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
 * Ralph configuration
 */
export interface RalphConfig {
	/** Default agent to use */
	default_agent: string;
	/** Default max iterations */
	default_iterations: number;
	/** Whether to auto-archive completed PRDs */
	auto_archive: boolean;
	/** Available agents */
	agents: Record<string, AgentConfig>;
}
