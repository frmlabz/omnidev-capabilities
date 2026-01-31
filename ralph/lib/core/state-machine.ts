/**
 * Ralph State Machines
 *
 * Explicit state transition logic for PRDs and Stories.
 * All state changes must go through these machines for validation.
 */

import type { PRDStatus, StoryStatus } from "../types.js";
import { type Result, ok, err, ErrorCodes } from "../results.js";

/**
 * PRD state transitions
 * pending -> in_progress (start work)
 * in_progress -> testing (all stories complete) | pending (reset/stop)
 * testing -> completed (tests pass) | in_progress (tests fail, resume work)
 * completed -> (terminal state)
 */
const PRD_TRANSITIONS: Record<PRDStatus, PRDStatus[]> = {
	pending: ["in_progress"],
	in_progress: ["testing", "pending"],
	testing: ["completed", "in_progress"],
	completed: [],
};

/**
 * Story state transitions
 * pending -> in_progress (start work)
 * in_progress -> completed (work done) | blocked (needs input) | pending (reset)
 * blocked -> pending (unblocked)
 * completed -> (terminal state)
 */
const STORY_TRANSITIONS: Record<StoryStatus, StoryStatus[]> = {
	pending: ["in_progress"],
	in_progress: ["completed", "blocked", "pending"],
	blocked: ["pending"],
	completed: [],
};

/**
 * PRD State Machine
 */
export const PRDStateMachine = {
	/**
	 * Get valid transitions from a given state
	 */
	validTransitions(from: PRDStatus): PRDStatus[] {
		return PRD_TRANSITIONS[from] ?? [];
	},

	/**
	 * Check if a transition is valid
	 */
	canTransition(from: PRDStatus, to: PRDStatus): boolean {
		return PRD_TRANSITIONS[from]?.includes(to) ?? false;
	},

	/**
	 * Validate a transition
	 */
	validateTransition(from: PRDStatus, to: PRDStatus): Result<void> {
		if (this.canTransition(from, to)) {
			return ok(undefined);
		}
		const validOptions = this.validTransitions(from);
		return err(
			ErrorCodes.PRD_INVALID_STATUS,
			`Cannot transition PRD from '${from}' to '${to}'. Valid transitions: ${validOptions.length > 0 ? validOptions.join(", ") : "none (terminal state)"}`,
		);
	},

	/**
	 * Get the display name for a status
	 */
	displayName(status: PRDStatus): string {
		const names: Record<PRDStatus, string> = {
			pending: "Pending",
			in_progress: "In Progress",
			testing: "Testing",
			completed: "Completed",
		};
		return names[status];
	},

	/**
	 * Check if status is terminal
	 */
	isTerminal(status: PRDStatus): boolean {
		return status === "completed";
	},
};

/**
 * Story State Machine
 */
export const StoryStateMachine = {
	/**
	 * Get valid transitions from a given state
	 */
	validTransitions(from: StoryStatus): StoryStatus[] {
		return STORY_TRANSITIONS[from] ?? [];
	},

	/**
	 * Check if a transition is valid
	 */
	canTransition(from: StoryStatus, to: StoryStatus): boolean {
		return STORY_TRANSITIONS[from]?.includes(to) ?? false;
	},

	/**
	 * Validate a transition
	 */
	validateTransition(from: StoryStatus, to: StoryStatus): Result<void> {
		if (this.canTransition(from, to)) {
			return ok(undefined);
		}
		const validOptions = this.validTransitions(from);
		return err(
			ErrorCodes.PRD_INVALID_STATUS,
			`Cannot transition story from '${from}' to '${to}'. Valid transitions: ${validOptions.length > 0 ? validOptions.join(", ") : "none (terminal state)"}`,
		);
	},

	/**
	 * Get the display name for a status
	 */
	displayName(status: StoryStatus): string {
		const names: Record<StoryStatus, string> = {
			pending: "Pending",
			in_progress: "In Progress",
			completed: "Completed",
			blocked: "Blocked",
		};
		return names[status];
	},

	/**
	 * Check if status is terminal
	 */
	isTerminal(status: StoryStatus): boolean {
		return status === "completed";
	},

	/**
	 * Check if story can be worked on
	 */
	isWorkable(status: StoryStatus): boolean {
		return status === "pending" || status === "in_progress";
	},

	/**
	 * Check if story requires user input
	 */
	requiresInput(status: StoryStatus): boolean {
		return status === "blocked";
	},
};

/**
 * PRD Display State (combines PRD status with worktree existence)
 * This is what the UI shows to users
 */
export type DisplayState = "pending" | "in_progress" | "testing" | "completed";

/**
 * Display state transitions (for UI validation)
 */
const DISPLAY_TRANSITIONS: Record<DisplayState, DisplayState[]> = {
	pending: ["in_progress"],
	in_progress: ["testing", "pending"],
	testing: ["completed", "in_progress"],
	completed: [],
};

/**
 * Display State Machine (for UI)
 */
export const DisplayStateMachine = {
	/**
	 * Compute display state from PRD status
	 * Now that in_progress is a real PRD status, display state matches PRD status directly
	 */
	compute(prdStatus: PRDStatus, _hasWorktree: boolean): DisplayState {
		// Display state now matches PRD status directly
		return prdStatus as DisplayState;
	},

	/**
	 * Get valid transitions from a given display state
	 */
	validTransitions(from: DisplayState): DisplayState[] {
		return DISPLAY_TRANSITIONS[from] ?? [];
	},

	/**
	 * Check if a display state transition is valid
	 */
	canTransition(from: DisplayState, to: DisplayState): boolean {
		return DISPLAY_TRANSITIONS[from]?.includes(to) ?? false;
	},

	/**
	 * Get available actions for a display state
	 */
	availableActions(state: DisplayState): string[] {
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
	},
};
