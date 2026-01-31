/**
 * Ralph State Management
 *
 * Functions for persisting and retrieving PRDs, stories, and progress.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AgentConfig,
	DependencyInfo,
	LastRun,
	PRD,
	PRDStatus,
	PRDSummary,
	Story,
	StoryStatus,
} from "./types.js";

const RALPH_DIR = ".omni/state/ralph";
const FINDINGS_PATH = join(RALPH_DIR, "findings.md");

const PRD_STATUS_DIRS: Record<PRDStatus, string> = {
	pending: join(RALPH_DIR, "prds", "pending"),
	in_progress: join(RALPH_DIR, "prds", "in_progress"),
	testing: join(RALPH_DIR, "prds", "testing"),
	completed: join(RALPH_DIR, "prds", "completed"),
};

const ALL_STATUSES: PRDStatus[] = ["pending", "in_progress", "testing", "completed"];

/**
 * Ensure all status directories exist
 */
export function ensureDirectories(): void {
	for (const dir of Object.values(PRD_STATUS_DIRS)) {
		mkdirSync(join(process.cwd(), dir), { recursive: true });
	}
}

/**
 * Get the path to a PRD directory by status
 */
function getPRDPathByStatus(name: string, status: PRDStatus): string {
	return join(process.cwd(), PRD_STATUS_DIRS[status], name);
}

/**
 * Get the path to a PRD file by status
 */
function getPRDFilePathByStatus(name: string, status: PRDStatus): string {
	return join(getPRDPathByStatus(name, status), "prd.json");
}

/**
 * Find which status folder contains a PRD
 * Returns null if not found
 */
export function findPRDLocation(name: string): PRDStatus | null {
	for (const status of ALL_STATUSES) {
		const prdPath = getPRDFilePathByStatus(name, status);
		if (existsSync(prdPath)) {
			return status;
		}
	}
	return null;
}

/**
 * Get the path to a PRD directory (finds location automatically)
 */
function getPRDPath(name: string): string | null {
	const status = findPRDLocation(name);
	if (!status) return null;
	return getPRDPathByStatus(name, status);
}

/**
 * Get the path to a PRD file (finds location automatically)
 */
function getPRDFilePath(name: string): string | null {
	const status = findPRDLocation(name);
	if (!status) return null;
	return getPRDFilePathByStatus(name, status);
}

/**
 * Get the path to a progress file
 */
function getProgressFilePath(name: string): string | null {
	const prdPath = getPRDPath(name);
	if (!prdPath) return null;
	return join(prdPath, "progress.txt");
}

/**
 * Get the path to the spec file
 */
function getSpecFilePath(name: string): string | null {
	const prdPath = getPRDPath(name);
	if (!prdPath) return null;
	return join(prdPath, "spec.md");
}

/**
 * List PRDs by status (or all if no status specified)
 */
export async function listPRDsByStatus(
	status?: PRDStatus,
): Promise<Array<{ name: string; status: PRDStatus }>> {
	const results: Array<{ name: string; status: PRDStatus }> = [];
	const statusesToCheck = status ? [status] : ALL_STATUSES;

	for (const s of statusesToCheck) {
		const dirPath = join(process.cwd(), PRD_STATUS_DIRS[s]);
		if (!existsSync(dirPath)) continue;

		const entries = readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const prdPath = join(dirPath, entry.name, "prd.json");
				if (existsSync(prdPath)) {
					results.push({ name: entry.name, status: s });
				}
			}
		}
	}

	return results;
}

/**
 * List all PRDs (backward compatible - returns just names)
 */
export async function listPRDs(): Promise<string[]> {
	const results: string[] = [];

	for (const status of ALL_STATUSES) {
		const dirPath = join(process.cwd(), PRD_STATUS_DIRS[status]);
		if (!existsSync(dirPath)) continue;

		const entries = readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				results.push(entry.name);
			}
		}
	}

	return results;
}

/**
 * Get PRD summaries for daemon API (richer data structure)
 */
export async function getPRDSummaries(includeCompleted = false): Promise<PRDSummary[]> {
	const prds = await listPRDsByStatus();
	const summaries: PRDSummary[] = [];

	for (const { name, status } of prds) {
		if (!includeCompleted && status === "completed") continue;

		try {
			const prd = await getPRD(name);
			const { canStart, unmetDependencies } = await canStartPRD(name);
			const blocked = prd.stories.filter((s) => s.status === "blocked");

			summaries.push({
				name: prd.name,
				status,
				description: prd.description,
				progress: {
					completed: prd.stories.filter((s) => s.status === "completed").length,
					total: prd.stories.length,
					inProgress: prd.stories.filter((s) => s.status === "in_progress").length,
					blocked: blocked.length,
				},
				canStart,
				hasBlockedStories: blocked.length > 0,
				dependencies: prd.dependencies ?? [],
				unmetDependencies,
				startedAt: prd.startedAt,
				completedAt: prd.completedAt,
				metrics: prd.metrics,
			});
		} catch {
			// Skip invalid PRDs
		}
	}

	return summaries;
}

/**
 * Move a PRD to a different status folder
 */
export async function movePRD(name: string, toStatus: PRDStatus): Promise<void> {
	const currentStatus = findPRDLocation(name);
	if (!currentStatus) {
		throw new Error(`PRD not found: ${name}`);
	}

	if (currentStatus === toStatus) {
		return;
	}

	const sourcePath = getPRDPathByStatus(name, currentStatus);
	const destDir = join(process.cwd(), PRD_STATUS_DIRS[toStatus]);
	const destPath = join(destDir, name);

	mkdirSync(destDir, { recursive: true });

	if (existsSync(destPath)) {
		throw new Error(`PRD already exists in ${toStatus}: ${name}`);
	}

	renameSync(sourcePath, destPath);
}

/**
 * Get a PRD by name (searches all status folders)
 */
export async function getPRD(name: string): Promise<PRD> {
	const prdPath = getPRDFilePath(name);

	if (!prdPath || !existsSync(prdPath)) {
		throw new Error(`PRD not found: ${name}`);
	}

	const content = await readFile(prdPath, "utf-8");
	const prd = JSON.parse(content) as PRD;

	if (prd.name === undefined || prd.description === undefined || prd.stories === undefined) {
		throw new Error(`Invalid PRD structure: ${name}`);
	}

	return prd;
}

/**
 * Update an existing PRD
 */
export async function updatePRD(name: string, updates: Partial<PRD>): Promise<PRD> {
	const existingPRD = await getPRD(name);
	const prdPath = getPRDFilePath(name);

	if (!prdPath) {
		throw new Error(`PRD not found: ${name}`);
	}

	const updatedPRD: PRD = {
		...existingPRD,
		...updates,
		name: existingPRD.name,
	};

	await writeFile(prdPath, JSON.stringify(updatedPRD, null, 2));

	return updatedPRD;
}

/**
 * Save a PRD directly (overwrites existing)
 */
export async function savePRD(name: string, prd: PRD): Promise<void> {
	const prdPath = getPRDFilePath(name);
	if (!prdPath) {
		throw new Error(`PRD not found: ${name}`);
	}
	await writeFile(prdPath, JSON.stringify(prd, null, 2));
}

/**
 * Get the next pending story from a PRD (sorted by priority)
 */
export async function getNextStory(prdName: string): Promise<Story | null> {
	const prd = await getPRD(prdName);

	const workableStories = prd.stories
		.filter((story) => story.status === "pending" || story.status === "in_progress")
		.sort((a, b) => a.priority - b.priority);

	return workableStories[0] ?? null;
}

/**
 * Update a story's status
 */
export async function updateStoryStatus(
	prdName: string,
	storyId: string,
	status: StoryStatus,
	questions?: string[],
): Promise<void> {
	const prd = await getPRD(prdName);

	const story = prd.stories.find((s) => s.id === storyId);
	if (!story) {
		throw new Error(`Story not found: ${storyId}`);
	}

	story.status = status;
	if (questions !== undefined) {
		story.questions = questions;
	}

	await updatePRD(prdName, { stories: prd.stories });
}

/**
 * Unblock a story by providing answers to its questions
 */
export async function unblockStory(
	prdName: string,
	storyId: string,
	answers: string[],
): Promise<void> {
	const prd = await getPRD(prdName);

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

	await updatePRD(prdName, { stories: prd.stories });
}

/**
 * Update the lastRun field in PRD
 */
export async function updateLastRun(prdName: string, lastRun: LastRun): Promise<void> {
	await updatePRD(prdName, { lastRun });
}

/**
 * Mark a PRD as started (sets startedAt if not already set)
 */
export async function markPRDStarted(prdName: string): Promise<void> {
	const prd = await getPRD(prdName);
	if (!prd.startedAt) {
		await updatePRD(prdName, { startedAt: new Date().toISOString() });
	}
}

/**
 * Mark a PRD as completed (sets completedAt)
 */
export async function markPRDCompleted(prdName: string): Promise<void> {
	await updatePRD(prdName, { completedAt: new Date().toISOString() });
}

/**
 * Update PRD metrics (accumulates values)
 */
export async function updateMetrics(
	prdName: string,
	newMetrics: { inputTokens?: number; outputTokens?: number; iterations?: number },
): Promise<void> {
	const prd = await getPRD(prdName);
	const existing = prd.metrics ?? {};

	const updated = {
		inputTokens: (existing.inputTokens ?? 0) + (newMetrics.inputTokens ?? 0),
		outputTokens: (existing.outputTokens ?? 0) + (newMetrics.outputTokens ?? 0),
		totalTokens:
			(existing.inputTokens ?? 0) +
			(newMetrics.inputTokens ?? 0) +
			(existing.outputTokens ?? 0) +
			(newMetrics.outputTokens ?? 0),
		iterations: (existing.iterations ?? 0) + (newMetrics.iterations ?? 0),
	};

	await updatePRD(prdName, { metrics: updated });
}

/**
 * Append content to the progress log
 */
export async function appendProgress(prdName: string, content: string): Promise<void> {
	const progressPath = getProgressFilePath(prdName);

	if (!progressPath) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	let existingContent = "";
	if (existsSync(progressPath)) {
		existingContent = await readFile(progressPath, "utf-8");
	}

	const updatedContent = `${existingContent}\n${content}\n`;
	await writeFile(progressPath, updatedContent);
}

/**
 * Get the progress log content
 */
export async function getProgress(prdName: string): Promise<string> {
	const progressPath = getProgressFilePath(prdName);

	if (!progressPath || !existsSync(progressPath)) {
		return "";
	}

	return await readFile(progressPath, "utf-8");
}

/**
 * Get the spec file content
 */
export async function getSpec(prdName: string): Promise<string> {
	const specPath = getSpecFilePath(prdName);

	if (!specPath || !existsSync(specPath)) {
		throw new Error(`Spec file not found for PRD: ${prdName}`);
	}

	return await readFile(specPath, "utf-8");
}

/**
 * Check if all stories in a PRD are completed
 */
export async function isPRDComplete(prdName: string): Promise<boolean> {
	const prd = await getPRD(prdName);
	return prd.stories.every((story) => story.status === "completed");
}

/**
 * Check if any stories are blocked
 */
export async function hasBlockedStories(prdName: string): Promise<Story[]> {
	const prd = await getPRD(prdName);
	return prd.stories.filter((story) => story.status === "blocked");
}

/**
 * Check if a PRD is complete (completed status or all stories completed)
 */
export async function isPRDCompleteOrArchived(prdName: string): Promise<boolean> {
	const status = findPRDLocation(prdName);

	if (status === "completed") {
		return true;
	}

	if (status === "pending" || status === "testing") {
		return await isPRDComplete(prdName);
	}

	return false;
}

/**
 * Get unmet dependencies for a PRD
 */
export async function getUnmetDependencies(prdName: string): Promise<string[]> {
	const prd = await getPRD(prdName);
	const dependencies = prd.dependencies ?? [];

	if (dependencies.length === 0) {
		return [];
	}

	const unmet: string[] = [];
	for (const dep of dependencies) {
		const isComplete = await isPRDCompleteOrArchived(dep);
		if (!isComplete) {
			unmet.push(dep);
		}
	}

	return unmet;
}

/**
 * Check if a PRD can be started (all dependencies complete)
 */
export async function canStartPRD(
	prdName: string,
): Promise<{ canStart: boolean; unmetDependencies: string[] }> {
	const unmetDependencies = await getUnmetDependencies(prdName);
	return {
		canStart: unmetDependencies.length === 0,
		unmetDependencies,
	};
}

/**
 * Build dependency graph for all active PRDs
 */
export async function buildDependencyGraph(): Promise<DependencyInfo[]> {
	const prds = await listPRDsByStatus();
	const graph: DependencyInfo[] = [];

	for (const { name, status } of prds) {
		try {
			const prd = await getPRD(name);
			const isComplete = await isPRDComplete(name);
			const { canStart, unmetDependencies } = await canStartPRD(name);

			graph.push({
				name,
				status,
				dependencies: prd.dependencies ?? [],
				isComplete,
				canStart,
				unmetDependencies,
			});
		} catch {
			// Skip invalid PRDs
		}
	}

	return graph;
}

/**
 * Extract findings from a PRD's progress.txt
 */
export async function extractFindings(prdName: string): Promise<string> {
	const progressContent = await getProgress(prdName);
	if (!progressContent) {
		return "";
	}

	const findings: string[] = [];

	// Extract patterns from "## Codebase Patterns" section
	const patternsMatch = progressContent.match(
		/## Codebase Patterns\s*\n([\s\S]*?)(?=\n---|\n## (?!Codebase))/,
	);
	const patterns = patternsMatch?.[1]?.trim();

	// Extract learnings from "**Learnings for future iterations:**" sections
	const learningsRegex =
		/\*\*Learnings for future iterations:\*\*\s*\n([\s\S]*?)(?=\n---|\n## |\n\*\*|$)/g;
	const learnings: string[] = [];
	let match = learningsRegex.exec(progressContent);
	while (match !== null) {
		const learning = match[1]?.trim();
		if (learning) {
			learnings.push(learning);
		}
		match = learningsRegex.exec(progressContent);
	}

	if (patterns || learnings.length > 0) {
		const timestamp = new Date().toISOString().split("T")[0];
		findings.push(`## [${timestamp}] ${prdName}\n`);

		if (patterns) {
			findings.push("### Patterns");
			findings.push(patterns);
			findings.push("");
		}

		if (learnings.length > 0) {
			findings.push("### Learnings");
			for (const learning of learnings) {
				findings.push(learning);
			}
			findings.push("");
		}

		findings.push("---\n");
	}

	return findings.join("\n");
}

/**
 * Append findings to the global findings.md file
 */
export async function appendToFindings(content: string): Promise<void> {
	if (!content.trim()) return;

	const findingsPath = join(process.cwd(), FINDINGS_PATH);
	let existingContent = "";

	if (existsSync(findingsPath)) {
		existingContent = await readFile(findingsPath, "utf-8");
	} else {
		existingContent = "# Ralph Findings\n\n";
		mkdirSync(join(process.cwd(), RALPH_DIR), { recursive: true });
	}

	await writeFile(findingsPath, existingContent + content);
}

/**
 * Extract findings from a PRD and append to findings.md
 * If agentConfig is provided, uses LLM to extract findings.
 * Otherwise falls back to regex-based extraction.
 */
export async function extractAndSaveFindings(
	prdName: string,
	agentConfig?: AgentConfig,
	runAgentFn?: (
		prompt: string,
		config: AgentConfig,
	) => Promise<{ output: string; exitCode: number }>,
): Promise<void> {
	let findings: string;

	if (agentConfig && runAgentFn) {
		// Use LLM-based extraction
		const { generateFindingsExtractionPrompt } = await import("./prompt.js");
		const prompt = await generateFindingsExtractionPrompt(prdName);
		const { output } = await runAgentFn(prompt, agentConfig);

		// Extract markdown from output (agent may include extra text)
		const markdownMatch = output.match(/## \[\d{4}-\d{2}-\d{2}\][\s\S]*?(?=\n## \[|$)/);
		findings = markdownMatch ? `${markdownMatch[0]}\n\n` : output;
	} else {
		// Fall back to regex-based extraction
		findings = await extractFindings(prdName);
	}

	await appendToFindings(findings);
}

/**
 * Migrate from old folder structure to new status-based structure
 */
export async function migrateToStatusFolders(): Promise<{ migrated: number; errors: string[] }> {
	const oldPrdsDir = join(process.cwd(), RALPH_DIR, "prds");
	const oldCompletedDir = join(process.cwd(), RALPH_DIR, "completed-prds");

	const migrated: string[] = [];
	const errors: string[] = [];

	ensureDirectories();

	// Check if migration is needed by looking for PRDs directly in prds/ (not in status subfolders)
	if (existsSync(oldPrdsDir)) {
		const entries = readdirSync(oldPrdsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (["pending", "in_progress", "testing", "completed"].includes(entry.name)) continue;

			const prdJsonPath = join(oldPrdsDir, entry.name, "prd.json");
			if (!existsSync(prdJsonPath)) continue;

			const destPath = join(process.cwd(), PRD_STATUS_DIRS.pending, entry.name);
			if (existsSync(destPath)) {
				errors.push(`Cannot migrate ${entry.name}: already exists in pending`);
				continue;
			}

			try {
				renameSync(join(oldPrdsDir, entry.name), destPath);
				migrated.push(entry.name);
			} catch (e) {
				errors.push(`Failed to migrate ${entry.name}: ${e}`);
			}
		}
	}

	// Migrate completed-prds to completed (stripping date prefix)
	if (existsSync(oldCompletedDir)) {
		const entries = readdirSync(oldCompletedDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			// Strip date prefix (YYYY-MM-DD-)
			const match = entry.name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
			const baseName = match?.[1] ?? entry.name;

			const destPath = join(process.cwd(), PRD_STATUS_DIRS.completed, baseName);
			if (existsSync(destPath)) {
				errors.push(`Cannot migrate ${entry.name}: ${baseName} already exists in completed`);
				continue;
			}

			try {
				renameSync(join(oldCompletedDir, entry.name), destPath);
				migrated.push(`${entry.name} -> completed/${baseName}`);
			} catch (e) {
				errors.push(`Failed to migrate ${entry.name}: ${e}`);
			}
		}

		// Remove old completed-prds directory if empty
		try {
			const remaining = readdirSync(oldCompletedDir);
			if (remaining.length === 0) {
				rmSync(oldCompletedDir, { recursive: true });
			}
		} catch {
			// Ignore
		}
	}

	return { migrated: migrated.length, errors };
}

/**
 * Get the next fix story ID for a PRD
 */
export async function getNextFixStoryId(prdName: string): Promise<string> {
	const prd = await getPRD(prdName);
	const fixStories = prd.stories.filter((s) => s.id.startsWith("FIX-"));
	const maxNum = fixStories.reduce((max, s) => {
		const num = Number.parseInt(s.id.replace("FIX-", ""), 10);
		return Number.isNaN(num) ? max : Math.max(max, num);
	}, 0);
	return `FIX-${String(maxNum + 1).padStart(3, "0")}`;
}

/**
 * Add a fix story to a PRD based on test failures
 */
export async function addFixStory(
	prdName: string,
	issues: string[],
	testResultsPath: string,
): Promise<string> {
	const prd = await getPRD(prdName);
	const storyId = await getNextFixStoryId(prdName);
	const date = new Date().toISOString().split("T")[0];

	const newStory = {
		id: storyId,
		title: `Fix bugs from testing (${date})`,
		status: "pending" as const,
		priority: 1, // High priority - fix bugs first
		acceptanceCriteria: [
			`Review test results at ${testResultsPath}`,
			...issues.map((issue) => `Fix: ${issue}`),
			"Ensure all items in verification.md pass",
			"All project quality checks must pass",
		],
		questions: [],
	};

	prd.stories.push(newStory);
	await savePRD(prdName, prd);

	return storyId;
}

/**
 * Get the test results directory path for a PRD
 */
export function getTestResultsDir(prdName: string): string | null {
	const status = findPRDLocation(prdName);
	if (!status) return null;
	return join(process.cwd(), PRD_STATUS_DIRS[status], prdName, "test-results");
}

/**
 * Clear the test results directory for a PRD
 */
export async function clearTestResults(prdName: string): Promise<void> {
	const testResultsDir = getTestResultsDir(prdName);
	if (!testResultsDir) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	if (existsSync(testResultsDir)) {
		rmSync(testResultsDir, { recursive: true });
	}

	// Recreate empty directory structure
	mkdirSync(testResultsDir, { recursive: true });
	mkdirSync(join(testResultsDir, "screenshots"), { recursive: true });
	mkdirSync(join(testResultsDir, "api-responses"), { recursive: true });
}

/**
 * Check if migration is needed
 */
export function needsMigration(): boolean {
	const oldPrdsDir = join(process.cwd(), RALPH_DIR, "prds");
	const oldCompletedDir = join(process.cwd(), RALPH_DIR, "completed-prds");

	// Check for PRDs directly in prds/ (not in status subfolders)
	if (existsSync(oldPrdsDir)) {
		const entries = readdirSync(oldPrdsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (["pending", "in_progress", "testing", "completed"].includes(entry.name)) continue;

			const prdJsonPath = join(oldPrdsDir, entry.name, "prd.json");
			if (existsSync(prdJsonPath)) {
				return true;
			}
		}
	}

	// Check for completed-prds directory
	if (existsSync(oldCompletedDir)) {
		const entries = readdirSync(oldCompletedDir, { withFileTypes: true });
		if (entries.some((e) => e.isDirectory())) {
			return true;
		}
	}

	return false;
}
