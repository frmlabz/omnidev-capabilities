/**
 * Ralph Result Types
 *
 * Structured result types for operations that can be parsed by both CLI and daemon.
 * All operations return a Result type with success/failure info.
 */

import type { PRDStatus, TestReport } from "./types.js";

/**
 * Base result type - all operations return this
 */
export interface Result<T = void> {
	ok: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

/**
 * Create a success result
 */
export function ok<T>(data: T): Result<T> {
	return { ok: true, data };
}

/**
 * Create an error result
 */
export function err(
	code: string,
	message: string,
	details?: Record<string, unknown>,
): Result<never> {
	return { ok: false, error: { code, message, details } };
}

/**
 * Error codes for PRD operations
 */
export const ErrorCodes = {
	// PRD errors
	PRD_NOT_FOUND: "PRD_NOT_FOUND",
	PRD_ALREADY_EXISTS: "PRD_ALREADY_EXISTS",
	PRD_INVALID_STATUS: "PRD_INVALID_STATUS",
	PRD_BLOCKED: "PRD_BLOCKED",

	// Agent errors
	AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
	AGENT_FAILED: "AGENT_FAILED",
	AGENT_TIMEOUT: "AGENT_TIMEOUT",

	// Config errors
	CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
	CONFIG_INVALID: "CONFIG_INVALID",

	// Health check errors
	HEALTH_CHECK_FAILED: "HEALTH_CHECK_FAILED",
	HEALTH_CHECK_TIMEOUT: "HEALTH_CHECK_TIMEOUT",

	// Script errors
	SCRIPT_NOT_FOUND: "SCRIPT_NOT_FOUND",
	SCRIPT_FAILED: "SCRIPT_FAILED",

	// General errors
	ALREADY_RUNNING: "ALREADY_RUNNING",
	NOT_RUNNING: "NOT_RUNNING",
	CANCELLED: "CANCELLED",
	UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * PRD display state (for UI/daemon)
 * Combines PRD status + worktree existence
 */
export type PRDDisplayState = "pending" | "in_progress" | "testing" | "completed";

/**
 * Compute display state from PRD status and worktree existence
 */
export function computeDisplayState(prdStatus: PRDStatus, hasWorktree: boolean): PRDDisplayState {
	if (prdStatus === "completed") return "completed";
	if (prdStatus === "testing") return "testing";
	if (prdStatus === "pending" && hasWorktree) return "in_progress";
	return "pending";
}

/**
 * Result of starting PRD development
 */
export interface StartResult {
	prdName: string;
	status: PRDStatus;
	displayState: PRDDisplayState;
	outcome: "moved_to_testing" | "blocked" | "max_iterations" | "interrupted" | "error";
	message: string;
	storiesCompleted: number;
	storiesRemaining: number;
	blockedStories?: string[];
	lastStoryId?: string;
}

/**
 * Result of running tests
 */
export interface TestResult {
	prdName: string;
	status: PRDStatus;
	displayState: PRDDisplayState;
	outcome: "verified" | "failed" | "unknown" | "health_check_failed" | "error";
	message: string;
	issues?: string[];
	report?: TestReport;
}

/**
 * Result of state query
 */
export interface StateResult {
	prdName: string;
	status: PRDStatus;
	displayState: PRDDisplayState;
	hasWorktree: boolean;
	stories: {
		total: number;
		completed: number;
		inProgress: number;
		blocked: number;
		pending: number;
	};
	canStart: boolean;
	canTest: boolean;
	canMerge: boolean;
}

/**
 * Transition validation
 */
export interface TransitionResult {
	allowed: boolean;
	from: PRDDisplayState;
	to: PRDDisplayState;
	reason?: string;
}

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS: Record<PRDDisplayState, PRDDisplayState[]> = {
	pending: ["in_progress"], // Start development
	in_progress: ["testing", "pending"], // Complete dev or fail back
	testing: ["completed", "in_progress"], // Pass tests or fail back
	completed: [], // Terminal state (merge happens outside)
};

/**
 * Check if a transition is valid
 */
export function isValidTransition(from: PRDDisplayState, to: PRDDisplayState): TransitionResult {
	const allowed = VALID_TRANSITIONS[from]?.includes(to) ?? false;

	if (!allowed) {
		return {
			allowed: false,
			from,
			to,
			reason: `Cannot transition from ${from} to ${to}. Valid transitions from ${from}: ${VALID_TRANSITIONS[from]?.join(", ") || "none"}`,
		};
	}

	return { allowed: true, from, to };
}

/**
 * Get available actions for a state
 */
export function getAvailableActions(state: PRDDisplayState): string[] {
	switch (state) {
		case "pending":
			return ["start"];
		case "in_progress":
			return ["start", "stop"]; // start = resume
		case "testing":
			return ["test", "stop"];
		case "completed":
			return ["merge"];
	}
}
