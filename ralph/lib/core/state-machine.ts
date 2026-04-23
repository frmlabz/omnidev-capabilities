/**
 * Ralph State Machines
 *
 * Explicit state transition logic for PRDs and Stories.
 * All state changes must go through these machines for validation.
 */

import { ErrorCodes, err, ok, type Result } from "../results.js";
import type { PRDStatus, StoryStatus } from "../types.js";

/**
 * PRD state transitions
 * pending -> in_progress (start work)
 * in_progress -> qa (all stories complete) | pending (reset/stop)
 * qa -> completed (QA passes) | in_progress (QA fails, resume work)
 * completed -> (terminal state)
 */
const PRD_TRANSITIONS: Record<PRDStatus, PRDStatus[]> = {
	pending: ["in_progress"],
	in_progress: ["qa", "pending"],
	qa: ["completed", "in_progress"],
	completed: [],
};

/**
 * Story state transitions
 * pending -> in_progress (start work)
 * in_progress -> completed (work done) | blocked (needs input) | pending (reset)
 * blocked -> pending (unblocked)
 * completed -> in_progress (per-story verifier rejected, story must be re-worked)
 */
const STORY_TRANSITIONS: Record<StoryStatus, StoryStatus[]> = {
	pending: ["in_progress"],
	in_progress: ["completed", "blocked", "pending"],
	blocked: ["pending"],
	completed: ["in_progress"],
};

/**
 * PRD State Machine
 */
export const PRDStateMachine = {
	validTransitions(from: PRDStatus): PRDStatus[] {
		return PRD_TRANSITIONS[from] ?? [];
	},

	canTransition(from: PRDStatus, to: PRDStatus): boolean {
		return PRD_TRANSITIONS[from]?.includes(to) ?? false;
	},

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

	displayName(status: PRDStatus): string {
		const names: Record<PRDStatus, string> = {
			pending: "Pending",
			in_progress: "In Progress",
			qa: "QA",
			completed: "Completed",
		};
		return names[status];
	},

	isTerminal(status: PRDStatus): boolean {
		return status === "completed";
	},
};

/**
 * Story State Machine
 */
export const StoryStateMachine = {
	validTransitions(from: StoryStatus): StoryStatus[] {
		return STORY_TRANSITIONS[from] ?? [];
	},

	canTransition(from: StoryStatus, to: StoryStatus): boolean {
		return STORY_TRANSITIONS[from]?.includes(to) ?? false;
	},

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

	displayName(status: StoryStatus): string {
		const names: Record<StoryStatus, string> = {
			pending: "Pending",
			in_progress: "In Progress",
			completed: "Completed",
			blocked: "Blocked",
		};
		return names[status];
	},

	isTerminal(status: StoryStatus): boolean {
		return status === "completed";
	},

	isWorkable(status: StoryStatus): boolean {
		return status === "pending" || status === "in_progress";
	},

	requiresInput(status: StoryStatus): boolean {
		return status === "blocked";
	},
};

/**
 * PRD Display State (combines PRD status with worktree existence)
 */
export type DisplayState = "pending" | "in_progress" | "qa" | "completed";

const DISPLAY_TRANSITIONS: Record<DisplayState, DisplayState[]> = {
	pending: ["in_progress"],
	in_progress: ["qa", "pending"],
	qa: ["completed", "in_progress"],
	completed: [],
};

export const DisplayStateMachine = {
	compute(prdStatus: PRDStatus, _hasWorktree: boolean): DisplayState {
		return prdStatus as DisplayState;
	},

	validTransitions(from: DisplayState): DisplayState[] {
		return DISPLAY_TRANSITIONS[from] ?? [];
	},

	canTransition(from: DisplayState, to: DisplayState): boolean {
		return DISPLAY_TRANSITIONS[from]?.includes(to) ?? false;
	},

	availableActions(state: DisplayState): string[] {
		switch (state) {
			case "pending":
				return ["start"];
			case "in_progress":
				return ["start", "stop"];
			case "qa":
				return ["qa", "stop"];
			case "completed":
				return ["merge"];
		}
	},
};
