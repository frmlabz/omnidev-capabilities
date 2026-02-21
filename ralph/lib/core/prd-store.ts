/**
 * Ralph PRD Store
 *
 * Unified storage for PRD operations.
 * All PRD read/write operations go through this class.
 * Includes Zod validation for all operations.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PRD, PRDStatus, Story, StoryStatus, LastRun } from "../types.js";
import { validatePRD } from "../schemas.js";
import { PRDStateMachine, StoryStateMachine } from "./state-machine.js";
import { type Result, ok, err, ErrorCodes } from "../results.js";

const RALPH_DIR = ".omni/state/ralph";

const PRD_STATUS_DIRS: Record<PRDStatus, string> = {
	pending: join(RALPH_DIR, "prds", "pending"),
	in_progress: join(RALPH_DIR, "prds", "in_progress"),
	testing: join(RALPH_DIR, "prds", "testing"),
	completed: join(RALPH_DIR, "prds", "completed"),
};

const ALL_STATUSES: PRDStatus[] = ["pending", "in_progress", "testing", "completed"];

/**
 * PRD Store - single source of truth for all PRD operations
 */
export class PRDStore {
	private cwd: string;

	constructor(cwd?: string) {
		this.cwd = cwd ?? process.cwd();
	}

	/**
	 * Ensure all status directories exist
	 */
	ensureDirectories(): void {
		for (const dir of Object.values(PRD_STATUS_DIRS)) {
			mkdirSync(join(this.cwd, dir), { recursive: true });
		}
	}

	/**
	 * Get the path to a PRD directory by status
	 */
	private getPRDPathByStatus(name: string, status: PRDStatus): string {
		return join(this.cwd, PRD_STATUS_DIRS[status], name);
	}

	/**
	 * Get the path to a PRD file by status
	 */
	private getPRDFilePathByStatus(name: string, status: PRDStatus): string {
		return join(this.getPRDPathByStatus(name, status), "prd.json");
	}

	/**
	 * Find which status folder contains a PRD
	 * A PRD folder is recognized if it contains prd.json or spec.md (spec-only during creation)
	 */
	findLocation(name: string): PRDStatus | null {
		for (const status of ALL_STATUSES) {
			const dirPath = this.getPRDPathByStatus(name, status);
			if (existsSync(join(dirPath, "prd.json")) || existsSync(join(dirPath, "spec.md"))) {
				return status;
			}
		}
		return null;
	}

	/**
	 * Get the path to a PRD directory (finds location automatically)
	 */
	getPRDPath(name: string): string | null {
		const status = this.findLocation(name);
		if (!status) return null;
		return this.getPRDPathByStatus(name, status);
	}

	/**
	 * Get the path to a PRD file (finds location automatically)
	 */
	private getPRDFilePath(name: string): string | null {
		const status = this.findLocation(name);
		if (!status) return null;
		return this.getPRDFilePathByStatus(name, status);
	}

	/**
	 * Load and validate a PRD by name
	 */
	async get(name: string): Promise<Result<PRD>> {
		const prdPath = this.getPRDFilePath(name);

		if (!prdPath || !existsSync(prdPath)) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${name}`);
		}

		try {
			const content = await readFile(prdPath, "utf-8");
			const parsed = JSON.parse(content);

			const validation = validatePRD(parsed);
			if (!validation.success) {
				return err(
					ErrorCodes.CONFIG_INVALID,
					`Invalid PRD structure: ${validation.error.errors.map((e) => e.message).join(", ")}`,
				);
			}

			return ok(validation.data as PRD);
		} catch (error) {
			return err(
				ErrorCodes.UNKNOWN,
				`Failed to read PRD: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Save a PRD (validates before saving)
	 */
	async save(name: string, prd: PRD): Promise<Result<void>> {
		const prdPath = this.getPRDFilePath(name);
		if (!prdPath) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${name}`);
		}

		// Validate before saving
		const validation = validatePRD(prd);
		if (!validation.success) {
			return err(
				ErrorCodes.CONFIG_INVALID,
				`Invalid PRD data: ${validation.error.errors.map((e) => e.message).join(", ")}`,
			);
		}

		try {
			await writeFile(prdPath, JSON.stringify(prd, null, 2));
			return ok(undefined);
		} catch (error) {
			return err(
				ErrorCodes.UNKNOWN,
				`Failed to save PRD: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Atomic update - load, modify, save
	 */
	async update(name: string, updater: (prd: PRD) => PRD | Promise<PRD>): Promise<Result<PRD>> {
		const getResult = await this.get(name);
		if (!getResult.ok) {
			return getResult as Result<PRD>;
		}

		const prd = getResult.data!;
		const updated = await updater(prd);

		const saveResult = await this.save(name, updated);
		if (!saveResult.ok) {
			return saveResult as unknown as Result<PRD>;
		}

		return ok(updated);
	}

	/**
	 * Transition PRD to a new status (validates transition)
	 */
	async transition(name: string, toStatus: PRDStatus): Promise<Result<void>> {
		const currentStatus = this.findLocation(name);
		if (!currentStatus) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${name}`);
		}

		if (currentStatus === toStatus) {
			return ok(undefined);
		}

		// Validate the transition
		const transitionResult = PRDStateMachine.validateTransition(currentStatus, toStatus);
		if (!transitionResult.ok) {
			return transitionResult;
		}

		// Move the PRD
		const sourcePath = this.getPRDPathByStatus(name, currentStatus);
		const destDir = join(this.cwd, PRD_STATUS_DIRS[toStatus]);
		const destPath = join(destDir, name);

		mkdirSync(destDir, { recursive: true });

		if (existsSync(destPath)) {
			return err(ErrorCodes.PRD_ALREADY_EXISTS, `PRD already exists in ${toStatus}: ${name}`);
		}

		try {
			renameSync(sourcePath, destPath);
			return ok(undefined);
		} catch (error) {
			return err(
				ErrorCodes.UNKNOWN,
				`Failed to move PRD: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * List PRDs by status (or all if no status specified)
	 */
	list(status?: PRDStatus): Array<{ name: string; status: PRDStatus }> {
		const results: Array<{ name: string; status: PRDStatus }> = [];
		const statusesToCheck = status ? [status] : ALL_STATUSES;

		for (const s of statusesToCheck) {
			const dirPath = join(this.cwd, PRD_STATUS_DIRS[s]);
			if (!existsSync(dirPath)) continue;

			const entries = readdirSync(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const entryDir = join(dirPath, entry.name);
					if (existsSync(join(entryDir, "prd.json")) || existsSync(join(entryDir, "spec.md"))) {
						results.push({ name: entry.name, status: s });
					}
				}
			}
		}

		return results;
	}

	/**
	 * Update a story's status with validation
	 */
	async updateStoryStatus(
		prdName: string,
		storyId: string,
		newStatus: StoryStatus,
		questions?: string[],
	): Promise<Result<void>> {
		return this.update(prdName, (prd) => {
			const story = prd.stories.find((s) => s.id === storyId);
			if (!story) {
				throw new Error(`Story not found: ${storyId}`);
			}

			// Validate the transition
			const transitionResult = StoryStateMachine.validateTransition(story.status, newStatus);
			if (!transitionResult.ok) {
				throw new Error(transitionResult.error!.message);
			}

			story.status = newStatus;
			if (questions !== undefined) {
				story.questions = questions;
			}

			return prd;
		}).then((result) => (result.ok ? ok(undefined) : (result as unknown as Result<void>)));
	}

	/**
	 * Get the next story to work on (pending or in_progress, sorted by priority)
	 */
	async getNextStory(prdName: string): Promise<Result<Story | null>> {
		const result = await this.get(prdName);
		if (!result.ok) {
			return result as unknown as Result<Story | null>;
		}

		const prd = result.data!;
		const workableStories = prd.stories
			.filter((story) => StoryStateMachine.isWorkable(story.status))
			.sort((a, b) => a.priority - b.priority);

		return ok(workableStories[0] ?? null);
	}

	/**
	 * Get blocked stories
	 */
	async getBlockedStories(prdName: string): Promise<Result<Story[]>> {
		const result = await this.get(prdName);
		if (!result.ok) {
			return result as unknown as Result<Story[]>;
		}

		const blocked = result.data!.stories.filter((s) => s.status === "blocked");
		return ok(blocked);
	}

	/**
	 * Check if PRD is complete (all stories completed)
	 */
	async isComplete(prdName: string): Promise<Result<boolean>> {
		const result = await this.get(prdName);
		if (!result.ok) {
			return result as unknown as Result<boolean>;
		}

		const allComplete = result.data!.stories.every((s) => s.status === "completed");
		return ok(allComplete);
	}

	/**
	 * Mark PRD as started (sets startedAt if not set)
	 */
	async markStarted(prdName: string): Promise<Result<void>> {
		return this.update(prdName, (prd) => {
			if (!prd.startedAt) {
				prd.startedAt = new Date().toISOString();
			}
			return prd;
		}).then((result) => (result.ok ? ok(undefined) : (result as unknown as Result<void>)));
	}

	/**
	 * Mark PRD as completed (sets completedAt)
	 */
	async markCompleted(prdName: string): Promise<Result<void>> {
		return this.update(prdName, (prd) => {
			prd.completedAt = new Date().toISOString();
			return prd;
		}).then((result) => (result.ok ? ok(undefined) : (result as unknown as Result<void>)));
	}

	/**
	 * Update last run info
	 */
	async updateLastRun(prdName: string, lastRun: LastRun): Promise<Result<void>> {
		return this.update(prdName, (prd) => {
			prd.lastRun = lastRun;
			return prd;
		}).then((result) => (result.ok ? ok(undefined) : (result as unknown as Result<void>)));
	}

	/**
	 * Update metrics (accumulates values)
	 */
	async updateMetrics(
		prdName: string,
		newMetrics: { inputTokens?: number; outputTokens?: number; iterations?: number },
	): Promise<Result<void>> {
		return this.update(prdName, (prd) => {
			const existing = prd.metrics ?? {};
			prd.metrics = {
				inputTokens: (existing.inputTokens ?? 0) + (newMetrics.inputTokens ?? 0),
				outputTokens: (existing.outputTokens ?? 0) + (newMetrics.outputTokens ?? 0),
				totalTokens:
					(existing.inputTokens ?? 0) +
					(newMetrics.inputTokens ?? 0) +
					(existing.outputTokens ?? 0) +
					(newMetrics.outputTokens ?? 0),
				iterations: (existing.iterations ?? 0) + (newMetrics.iterations ?? 0),
			};
			return prd;
		}).then((result) => (result.ok ? ok(undefined) : (result as unknown as Result<void>)));
	}

	/**
	 * Unblock a story by providing answers
	 */
	async unblockStory(prdName: string, storyId: string, answers: string[]): Promise<Result<void>> {
		return this.update(prdName, (prd) => {
			const story = prd.stories.find((s) => s.id === storyId);
			if (!story) {
				throw new Error(`Story not found: ${storyId}`);
			}

			if (story.status !== "blocked") {
				throw new Error(`Story ${storyId} is not blocked`);
			}

			if (answers.length !== story.questions.length) {
				throw new Error(`Expected ${story.questions.length} answers, got ${answers.length}`);
			}

			story.answers = answers;
			story.status = "pending";
			return prd;
		}).then((result) => (result.ok ? ok(undefined) : (result as unknown as Result<void>)));
	}

	/**
	 * Add a fix story for test failures
	 */
	async addFixStory(
		prdName: string,
		issues: string[],
		testResultsPath: string,
	): Promise<Result<string>> {
		let storyId = "";
		const result = await this.update(prdName, (prd) => {
			// Find next fix story ID
			const fixStories = prd.stories.filter((s) => s.id.startsWith("FIX-"));
			const maxNum = fixStories.reduce((max, s) => {
				const num = Number.parseInt(s.id.replace("FIX-", ""), 10);
				return Number.isNaN(num) ? max : Math.max(max, num);
			}, 0);
			storyId = `FIX-${String(maxNum + 1).padStart(3, "0")}`;

			const date = new Date().toISOString().split("T")[0];

			const newStory: Story = {
				id: storyId,
				title: `Fix bugs from testing (${date})`,
				status: "pending",
				priority: 1, // High priority
				acceptanceCriteria: [
					`Review test results at ${testResultsPath}`,
					...issues.map((issue) => `Fix: ${issue}`),
					"Ensure all items in verification.md pass",
					"All project quality checks must pass",
				],
				questions: [],
			};

			prd.stories.push(newStory);
			return prd;
		});

		if (!result.ok) {
			return result as unknown as Result<string>;
		}

		return ok(storyId);
	}

	/**
	 * Get test results directory path
	 */
	getTestResultsDir(prdName: string): string | null {
		const prdPath = this.getPRDPath(prdName);
		if (!prdPath) return null;
		return join(prdPath, "test-results");
	}

	/**
	 * Clear test results directory
	 */
	clearTestResults(prdName: string): Result<void> {
		const testResultsDir = this.getTestResultsDir(prdName);
		if (!testResultsDir) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
		}

		if (existsSync(testResultsDir)) {
			rmSync(testResultsDir, { recursive: true });
		}

		// Recreate empty directory structure
		mkdirSync(testResultsDir, { recursive: true });
		mkdirSync(join(testResultsDir, "screenshots"), { recursive: true });
		mkdirSync(join(testResultsDir, "api-responses"), { recursive: true });

		return ok(undefined);
	}

	/**
	 * Get progress file path
	 */
	getProgressPath(prdName: string): string | null {
		const prdPath = this.getPRDPath(prdName);
		if (!prdPath) return null;
		return join(prdPath, "progress.txt");
	}

	/**
	 * Get spec file path
	 */
	getSpecPath(prdName: string): string | null {
		const prdPath = this.getPRDPath(prdName);
		if (!prdPath) return null;
		return join(prdPath, "spec.md");
	}
}

// Default store instance using process.cwd()
let defaultStore: PRDStore | null = null;

/**
 * Get the default PRD store instance
 */
export function getDefaultStore(): PRDStore {
	if (!defaultStore) {
		defaultStore = new PRDStore();
	}
	return defaultStore;
}

/**
 * Create a new PRD store with a custom working directory
 */
export function createStore(cwd: string): PRDStore {
	return new PRDStore(cwd);
}
