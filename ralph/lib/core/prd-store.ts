/**
 * Ralph PRD Store
 *
 * Unified storage for PRD operations.
 * All PRD read/write operations go through this class.
 * Includes Zod validation for all operations.
 * Paths resolve to $XDG_STATE_HOME/omnidev/ralph/<project-key>/.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCodes, err, ok, type Result } from "../results.js";
import { validatePRD } from "../schemas.js";
import type { LastRun, PRD, PRDStatus, Story, StoryStatus } from "../types.js";
import { atomicWrite, ensureStateDirs, getStatusDir } from "./paths.js";
import { PRDStateMachine, StoryStateMachine } from "./state-machine.js";

const ALL_STATUSES: PRDStatus[] = ["pending", "in_progress", "qa", "completed"];

/**
 * PRD Store - single source of truth for all PRD operations
 */
export class PRDStore {
	private projectName: string;
	private repoRoot: string;

	constructor(projectName: string, repoRoot: string) {
		this.projectName = projectName;
		this.repoRoot = repoRoot;
	}

	/**
	 * Ensure all status directories exist
	 */
	ensureDirectories(): void {
		ensureStateDirs(this.projectName, this.repoRoot);
	}

	/**
	 * Get the path to a PRD directory by status
	 */
	private getPRDPathByStatus(name: string, status: PRDStatus): string {
		return join(getStatusDir(this.projectName, this.repoRoot, status), name);
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
			await atomicWrite(prdPath, JSON.stringify(prd, null, 2));
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
		const destDir = getStatusDir(this.projectName, this.repoRoot, toStatus);
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
			const dirPath = getStatusDir(this.projectName, this.repoRoot, s);
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
	 * Add a fix story for QA failures.
	 * Emits a story markdown file at `stories/<id>.md` and records `promptPath`.
	 */
	async addFixStory(
		prdName: string,
		issues: string[],
		qaResultsPath: string,
	): Promise<Result<string>> {
		const prdDir = this.getPRDPath(prdName);
		if (!prdDir) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
		}

		let storyId = "";
		let storyFilePath = "";
		let storyFileContent = "";

		const result = await this.update(prdName, (prd) => {
			const fixStories = prd.stories.filter((s) => s.id.startsWith("FIX-"));
			const maxNum = fixStories.reduce((max, s) => {
				const num = Number.parseInt(s.id.replace("FIX-", ""), 10);
				return Number.isNaN(num) ? max : Math.max(max, num);
			}, 0);
			storyId = `FIX-${String(maxNum + 1).padStart(3, "0")}`;
			const date = new Date().toISOString().split("T")[0];
			const promptPath = `stories/${storyId}.md`;
			storyFilePath = join(prdDir, promptPath);

			storyFileContent =
				[
					"---",
					`id: ${storyId}`,
					`title: Fix bugs from QA (${date})`,
					"priority: 1",
					"dependencies: []",
					"---",
					"",
				].join("\n") +
				`## Goal
Address QA failures reported for ${prdName}.

## Scope
- Review QA report and fix each reported issue
- Re-run the verification checklist items that failed

## Out of scope
- New features or refactors unrelated to the listed failures

## Deliverables
1. Each failure below resolved in code
2. All items in verification.md pass
3. Project quality checks (lint, typecheck, tests) pass

## Acceptance Criteria
- [ ] Review QA results at \`${qaResultsPath}\`
${issues.map((issue) => `- [ ] Fix: ${issue}`).join("\n")}
- [ ] All items in verification.md pass
- [ ] All project quality checks must pass
`;

			const newStory: Story = {
				id: storyId,
				title: `Fix bugs from QA (${date})`,
				status: "pending",
				priority: 1,
				promptPath,
				questions: [],
			};

			prd.stories.push(newStory);
			// Mark this PRD as coming from a QA failure so the next development-complete run
			// skips full review and goes directly to focused verification/QA.
			prd.qaCaughtIssue = true;
			return prd;
		});

		if (!result.ok) {
			return result as unknown as Result<string>;
		}

		try {
			mkdirSync(join(prdDir, "stories"), { recursive: true });
			await writeFile(storyFilePath, storyFileContent);
		} catch (error) {
			return err(
				ErrorCodes.UNKNOWN,
				`Failed to write story file: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		return ok(storyId);
	}

	/**
	 * Get QA results directory path
	 */
	getQAResultsDir(prdName: string): string | null {
		const prdPath = this.getPRDPath(prdName);
		if (!prdPath) return null;
		return join(prdPath, "qa-results");
	}

	/**
	 * Clear QA results directory
	 */
	clearQAResults(prdName: string): Result<void> {
		const qaResultsDir = this.getQAResultsDir(prdName);
		if (!qaResultsDir) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
		}

		if (existsSync(qaResultsDir)) {
			rmSync(qaResultsDir, { recursive: true });
		}

		// Recreate empty directory structure
		mkdirSync(qaResultsDir, { recursive: true });
		mkdirSync(join(qaResultsDir, "screenshots"), { recursive: true });
		mkdirSync(join(qaResultsDir, "api-responses"), { recursive: true });

		return ok(undefined);
	}

	/**
	 * Resolve the absolute path to a story's markdown file.
	 */
	getStoryFilePath(prdName: string, story: Story): string {
		const prdPath = this.getPRDPath(prdName);
		if (!prdPath) {
			throw new Error(`PRD not found: ${prdName}`);
		}
		return join(prdPath, story.promptPath);
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

/**
 * Get a PRD store for a given project
 */
export function getDefaultStore(projectName: string, repoRoot: string): PRDStore {
	return new PRDStore(projectName, repoRoot);
}

/**
 * Create a new PRD store (alias for constructor)
 */
export function createStore(projectName: string, repoRoot: string): PRDStore {
	return new PRDStore(projectName, repoRoot);
}
