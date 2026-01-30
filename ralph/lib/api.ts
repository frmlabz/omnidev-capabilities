/**
 * Ralph High-Level API
 *
 * Provides clean, structured return values for both daemon and CLI.
 * Wraps the event-based Orchestrator with result types.
 */

import { createOrchestrator, type OrchestratorEvent, type OrchestratorOptions } from "./events.js";
import { findPRDLocation, getPRD, hasBlockedStories } from "./state.js";
import {
	type Result,
	type StartResult,
	type TestResult,
	type StateResult,
	type PRDDisplayState,
	ok,
	err,
	ErrorCodes,
	computeDisplayState,
	getAvailableActions,
} from "./results.js";

/**
 * Get the current state of a PRD
 */
export async function getPRDState(
	prdName: string,
	hasWorktree = false,
): Promise<Result<StateResult>> {
	const status = findPRDLocation(prdName);
	if (!status) {
		return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
	}

	try {
		const prd = await getPRD(prdName);
		const displayState = computeDisplayState(status, hasWorktree);

		const stories = {
			total: prd.stories.length,
			completed: prd.stories.filter((s) => s.status === "completed").length,
			inProgress: prd.stories.filter((s) => s.status === "in_progress").length,
			blocked: prd.stories.filter((s) => s.status === "blocked").length,
			pending: prd.stories.filter((s) => s.status === "pending").length,
		};

		const blockedStories = await hasBlockedStories(prdName);
		const canStart = displayState === "pending" || displayState === "in_progress";
		const canTest = displayState === "testing";
		const canMerge = displayState === "completed";

		return ok({
			prdName,
			status,
			displayState,
			hasWorktree,
			stories,
			canStart: canStart && blockedStories.length === 0,
			canTest,
			canMerge,
		});
	} catch (error) {
		return err(ErrorCodes.UNKNOWN, error instanceof Error ? error.message : String(error));
	}
}

/**
 * Options for running with callback for events
 */
export interface RunOptions extends OrchestratorOptions {
	/** Callback for events (for real-time streaming) */
	onEvent?: (event: OrchestratorEvent) => void;
	/** Whether PRD has a worktree (for display state calculation) */
	hasWorktree?: boolean;
}

/**
 * Start PRD development
 * Returns structured result after completion
 */
export async function startDevelopment(
	prdName: string,
	options: RunOptions = {},
): Promise<Result<StartResult>> {
	const status = findPRDLocation(prdName);
	if (!status) {
		return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
	}

	const orchestrator = createOrchestrator();

	// Collect events for result
	let outcome: StartResult["outcome"] = "error";
	let message = "";
	let lastStoryId: string | undefined;
	const blockedStories: string[] = [];

	// Forward events if callback provided
	orchestrator.on("event", (event: OrchestratorEvent) => {
		options.onEvent?.(event);

		// Track state for result
		if (event.type === "complete") {
			switch (event.result) {
				case "success":
					outcome = "moved_to_testing";
					break;
				case "blocked":
					outcome = "blocked";
					break;
				case "max_iterations":
					outcome = "max_iterations";
					break;
				default:
					outcome = "error";
			}
			message = event.message;
		} else if (event.type === "iteration") {
			lastStoryId = event.storyId;
		} else if (event.type === "story_update" && event.status === "blocked") {
			blockedStories.push(event.storyId);
		} else if (event.type === "error") {
			outcome = "error";
			message = event.error;
		}
	});

	try {
		await orchestrator.runOrchestration(prdName, options);

		// Get final state
		const finalStatus = findPRDLocation(prdName) || status;
		const prd = await getPRD(prdName);
		const displayState = computeDisplayState(finalStatus, options.hasWorktree ?? true);

		const storiesCompleted = prd.stories.filter((s) => s.status === "completed").length;
		const storiesRemaining = prd.stories.filter((s) => s.status !== "completed").length;

		return ok({
			prdName,
			status: finalStatus,
			displayState,
			outcome,
			message: message || "Development completed",
			storiesCompleted,
			storiesRemaining,
			blockedStories: blockedStories.length > 0 ? blockedStories : undefined,
			lastStoryId,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Check for specific error types
		if (errorMessage.includes("already running")) {
			return err(ErrorCodes.ALREADY_RUNNING, errorMessage);
		}
		if (errorMessage.includes("not found")) {
			return err(ErrorCodes.AGENT_NOT_FOUND, errorMessage);
		}

		return err(ErrorCodes.UNKNOWN, errorMessage);
	}
}

/**
 * Run tests for a PRD
 * Returns structured result after completion
 */
export async function runTests(
	prdName: string,
	options: RunOptions = {},
): Promise<Result<TestResult>> {
	const status = findPRDLocation(prdName);
	if (!status) {
		return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
	}

	const orchestrator = createOrchestrator();

	// Collect events for result
	let outcome: TestResult["outcome"] = "unknown";
	let message = "";
	let issues: string[] = [];
	let healthCheckFailed = false;

	// Forward events if callback provided
	orchestrator.on("event", (event: OrchestratorEvent) => {
		options.onEvent?.(event);

		if (event.type === "test_complete") {
			outcome = event.result;
			issues = event.issues ?? [];
		} else if (event.type === "health_check_failed") {
			healthCheckFailed = true;
			outcome = "health_check_failed";
			message = event.error;
		} else if (event.type === "error") {
			outcome = "error";
			message = event.error;
		}
	});

	try {
		const result = await orchestrator.runTesting(prdName, options);

		// Get final state
		const finalStatus = findPRDLocation(prdName) || status;
		const displayState = computeDisplayState(finalStatus, options.hasWorktree ?? true);

		return ok({
			prdName,
			status: finalStatus,
			displayState,
			outcome: healthCheckFailed ? "health_check_failed" : outcome,
			message: message || `Testing ${outcome}`,
			issues: issues.length > 0 ? issues : undefined,
			report: result.report,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		if (errorMessage.includes("already running")) {
			return err(ErrorCodes.ALREADY_RUNNING, errorMessage);
		}

		return err(ErrorCodes.UNKNOWN, errorMessage);
	}
}

/**
 * Get available actions for a PRD based on its current state
 */
export async function getActions(prdName: string, hasWorktree = false): Promise<Result<string[]>> {
	const stateResult = await getPRDState(prdName, hasWorktree);
	if (!stateResult.ok) {
		return err(stateResult.error!.code, stateResult.error!.message);
	}

	return ok(getAvailableActions(stateResult.data!.displayState));
}

/**
 * Check if a PRD can transition to a specific state
 */
export async function canTransition(
	prdName: string,
	toState: PRDDisplayState,
	hasWorktree = false,
): Promise<Result<boolean>> {
	const stateResult = await getPRDState(prdName, hasWorktree);
	if (!stateResult.ok) {
		return err(stateResult.error!.code, stateResult.error!.message);
	}

	const currentState = stateResult.data!.displayState;

	// Valid transitions
	const validTransitions: Record<PRDDisplayState, PRDDisplayState[]> = {
		pending: ["in_progress"],
		in_progress: ["testing"],
		testing: ["completed", "in_progress"],
		completed: [],
	};

	const allowed = validTransitions[currentState]?.includes(toState) ?? false;
	return ok(allowed);
}
