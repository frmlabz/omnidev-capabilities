/**
 * Ralph State Management
 *
 * Functions for persisting and retrieving PRDs, stories, and progress.
 * All paths resolve to $XDG_STATE_HOME/omnidev/ralph/<project-key>/.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, ensureStateDirs, getStateDir, getStatusDir } from "./core/paths.js";
import type {
	DependencyInfo,
	LastRun,
	PRD,
	PRDStatus,
	PRDSummary,
	ProviderVariantConfig,
	Story,
	StoryStatus,
} from "./types.js";

const ALL_STATUSES: PRDStatus[] = ["pending", "in_progress", "qa", "completed"];

/**
 * Ensure all status directories exist
 */
export function ensureDirectories(projectName: string, repoRoot: string): void {
	ensureStateDirs(projectName, repoRoot);
}

/**
 * Get the path to a PRD directory by status
 */
function getPRDPathByStatus(
	projectName: string,
	repoRoot: string,
	name: string,
	status: PRDStatus,
): string {
	return join(getStatusDir(projectName, repoRoot, status), name);
}

/**
 * Get the path to a PRD file by status
 */
function getPRDFilePathByStatus(
	projectName: string,
	repoRoot: string,
	name: string,
	status: PRDStatus,
): string {
	return join(getPRDPathByStatus(projectName, repoRoot, name, status), "prd.json");
}

/**
 * Find which status folder contains a PRD
 * A PRD folder is recognized if it contains prd.json or spec.md (spec-only during creation)
 * Returns null if not found
 */
export function findPRDLocation(
	projectName: string,
	repoRoot: string,
	name: string,
): PRDStatus | null {
	for (const status of ALL_STATUSES) {
		const dirPath = getPRDPathByStatus(projectName, repoRoot, name, status);
		if (existsSync(join(dirPath, "prd.json")) || existsSync(join(dirPath, "spec.md"))) {
			return status;
		}
	}
	return null;
}

/**
 * Check if a PRD has a prd.json file (stories defined).
 * Spec-only PRDs (during creation) will return false.
 */
export function hasPRDFile(projectName: string, repoRoot: string, name: string): boolean {
	const status = findPRDLocation(projectName, repoRoot, name);
	if (!status) return false;
	return existsSync(join(getPRDPathByStatus(projectName, repoRoot, name, status), "prd.json"));
}

/**
 * Get the path to a PRD directory (finds location automatically)
 */
function getPRDPath(projectName: string, repoRoot: string, name: string): string | null {
	const status = findPRDLocation(projectName, repoRoot, name);
	if (!status) return null;
	return getPRDPathByStatus(projectName, repoRoot, name, status);
}

/**
 * Get the path to a PRD file (finds location automatically)
 */
function getPRDFilePath(projectName: string, repoRoot: string, name: string): string | null {
	const status = findPRDLocation(projectName, repoRoot, name);
	if (!status) return null;
	return getPRDFilePathByStatus(projectName, repoRoot, name, status);
}

/**
 * Get the path to a progress file
 */
function getProgressFilePath(projectName: string, repoRoot: string, name: string): string | null {
	const prdPath = getPRDPath(projectName, repoRoot, name);
	if (!prdPath) return null;
	return join(prdPath, "progress.txt");
}

/**
 * Get the path to the spec file
 */
function getSpecFilePath(projectName: string, repoRoot: string, name: string): string | null {
	const prdPath = getPRDPath(projectName, repoRoot, name);
	if (!prdPath) return null;
	return join(prdPath, "spec.md");
}

/**
 * List PRDs by status (or all if no status specified)
 */
export async function listPRDsByStatus(
	projectName: string,
	repoRoot: string,
	status?: PRDStatus,
): Promise<Array<{ name: string; status: PRDStatus }>> {
	const results: Array<{ name: string; status: PRDStatus }> = [];
	const statusesToCheck = status ? [status] : ALL_STATUSES;

	for (const s of statusesToCheck) {
		const dirPath = getStatusDir(projectName, repoRoot, s);
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
 * List all PRDs (backward compatible - returns just names)
 */
export async function listPRDs(projectName: string, repoRoot: string): Promise<string[]> {
	const results: string[] = [];

	for (const status of ALL_STATUSES) {
		const dirPath = getStatusDir(projectName, repoRoot, status);
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
export async function getPRDSummaries(
	projectName: string,
	repoRoot: string,
	includeCompleted = false,
): Promise<PRDSummary[]> {
	const prds = await listPRDsByStatus(projectName, repoRoot);
	const summaries: PRDSummary[] = [];

	for (const { name, status } of prds) {
		if (!includeCompleted && status === "completed") continue;

		try {
			const prd = await getPRD(projectName, repoRoot, name);
			const { canStart, unmetDependencies } = await canStartPRD(projectName, repoRoot, name);
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
export async function movePRD(
	projectName: string,
	repoRoot: string,
	name: string,
	toStatus: PRDStatus,
): Promise<void> {
	const currentStatus = findPRDLocation(projectName, repoRoot, name);
	if (!currentStatus) {
		throw new Error(`PRD not found: ${name}`);
	}

	if (currentStatus === toStatus) {
		return;
	}

	const sourcePath = getPRDPathByStatus(projectName, repoRoot, name, currentStatus);
	const destDir = getStatusDir(projectName, repoRoot, toStatus);
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
export async function getPRD(projectName: string, repoRoot: string, name: string): Promise<PRD> {
	const prdPath = getPRDFilePath(projectName, repoRoot, name);

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
export async function updatePRD(
	projectName: string,
	repoRoot: string,
	name: string,
	updates: Partial<PRD>,
): Promise<PRD> {
	const existingPRD = await getPRD(projectName, repoRoot, name);
	const prdPath = getPRDFilePath(projectName, repoRoot, name);

	if (!prdPath) {
		throw new Error(`PRD not found: ${name}`);
	}

	const updatedPRD: PRD = {
		...existingPRD,
		...updates,
		name: existingPRD.name,
	};

	await atomicWrite(prdPath, JSON.stringify(updatedPRD, null, 2));

	return updatedPRD;
}

/**
 * Save a PRD directly (overwrites existing)
 */
export async function savePRD(
	projectName: string,
	repoRoot: string,
	name: string,
	prd: PRD,
): Promise<void> {
	const prdPath = getPRDFilePath(projectName, repoRoot, name);
	if (!prdPath) {
		throw new Error(`PRD not found: ${name}`);
	}
	await atomicWrite(prdPath, JSON.stringify(prd, null, 2));
}

/**
 * Get the next pending story from a PRD (sorted by priority)
 */
export async function getNextStory(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<Story | null> {
	const prd = await getPRD(projectName, repoRoot, prdName);

	const workableStories = prd.stories
		.filter((story) => story.status === "pending" || story.status === "in_progress")
		.sort((a, b) => a.priority - b.priority);

	return workableStories[0] ?? null;
}

/**
 * Update a story's status
 */
export async function updateStoryStatus(
	projectName: string,
	repoRoot: string,
	prdName: string,
	storyId: string,
	status: StoryStatus,
	questions?: string[],
): Promise<void> {
	const prd = await getPRD(projectName, repoRoot, prdName);

	const story = prd.stories.find((s) => s.id === storyId);
	if (!story) {
		throw new Error(`Story not found: ${storyId}`);
	}

	story.status = status;
	if (questions !== undefined) {
		story.questions = questions;
	}

	await updatePRD(projectName, repoRoot, prdName, { stories: prd.stories });
}

/**
 * Unblock a story by providing answers to its questions
 */
export async function unblockStory(
	projectName: string,
	repoRoot: string,
	prdName: string,
	storyId: string,
	answers: string[],
): Promise<void> {
	const prd = await getPRD(projectName, repoRoot, prdName);

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

	await updatePRD(projectName, repoRoot, prdName, { stories: prd.stories });
}

/**
 * Update the lastRun field in PRD
 */
export async function updateLastRun(
	projectName: string,
	repoRoot: string,
	prdName: string,
	lastRun: LastRun,
): Promise<void> {
	await updatePRD(projectName, repoRoot, prdName, { lastRun });
}

/**
 * Mark a PRD as started (sets startedAt if not already set)
 */
export async function markPRDStarted(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<void> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	if (!prd.startedAt) {
		await updatePRD(projectName, repoRoot, prdName, { startedAt: new Date().toISOString() });
	}
}

/**
 * Mark a PRD as completed (sets completedAt)
 */
export async function markPRDCompleted(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<void> {
	await updatePRD(projectName, repoRoot, prdName, { completedAt: new Date().toISOString() });
}

/**
 * Update PRD metrics (accumulates values)
 */
export async function updateMetrics(
	projectName: string,
	repoRoot: string,
	prdName: string,
	newMetrics: { inputTokens?: number; outputTokens?: number; iterations?: number },
): Promise<void> {
	const prd = await getPRD(projectName, repoRoot, prdName);
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

	await updatePRD(projectName, repoRoot, prdName, { metrics: updated });
}

/**
 * Append content to the progress log
 */
export async function appendProgress(
	projectName: string,
	repoRoot: string,
	prdName: string,
	content: string,
): Promise<void> {
	const progressPath = getProgressFilePath(projectName, repoRoot, prdName);

	if (!progressPath) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	let existingContent = "";
	if (existsSync(progressPath)) {
		existingContent = await readFile(progressPath, "utf-8");
	}

	const updatedContent = `${existingContent}\n${content}\n`;
	await atomicWrite(progressPath, updatedContent);
}

/**
 * Get the progress log content
 */
export async function getProgress(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string> {
	const progressPath = getProgressFilePath(projectName, repoRoot, prdName);

	if (!progressPath || !existsSync(progressPath)) {
		return "";
	}

	return await readFile(progressPath, "utf-8");
}

/**
 * Get the spec file content
 */
export async function getSpec(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string> {
	const specPath = getSpecFilePath(projectName, repoRoot, prdName);

	if (!specPath || !existsSync(specPath)) {
		throw new Error(`Spec file not found for PRD: ${prdName}`);
	}

	return await readFile(specPath, "utf-8");
}

/**
 * Check if all stories in a PRD are completed
 */
export async function isPRDComplete(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<boolean> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	return prd.stories.every((story) => story.status === "completed");
}

/**
 * Check if any stories are blocked
 */
export async function hasBlockedStories(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<Story[]> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	return prd.stories.filter((story) => story.status === "blocked");
}

/**
 * Check if a PRD is complete (completed status or all stories completed)
 */
export async function isPRDCompleteOrArchived(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<boolean> {
	const status = findPRDLocation(projectName, repoRoot, prdName);

	if (status === "completed") {
		return true;
	}

	if (status === "pending" || status === "qa") {
		return await isPRDComplete(projectName, repoRoot, prdName);
	}

	return false;
}

/**
 * Get unmet dependencies for a PRD
 */
export async function getUnmetDependencies(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string[]> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	const dependencies = prd.dependencies ?? [];

	if (dependencies.length === 0) {
		return [];
	}

	const unmet: string[] = [];
	for (const dep of dependencies) {
		const isComplete = await isPRDCompleteOrArchived(projectName, repoRoot, dep);
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
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<{ canStart: boolean; unmetDependencies: string[] }> {
	const unmetDependencies = await getUnmetDependencies(projectName, repoRoot, prdName);
	return {
		canStart: unmetDependencies.length === 0,
		unmetDependencies,
	};
}

/**
 * Build dependency graph for all active PRDs
 */
export async function buildDependencyGraph(
	projectName: string,
	repoRoot: string,
): Promise<DependencyInfo[]> {
	const prds = await listPRDsByStatus(projectName, repoRoot);
	const graph: DependencyInfo[] = [];

	for (const { name, status } of prds) {
		try {
			const prd = await getPRD(projectName, repoRoot, name);
			const isComplete = await isPRDComplete(projectName, repoRoot, name);
			const { canStart, unmetDependencies } = await canStartPRD(projectName, repoRoot, name);

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
export async function extractFindings(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string> {
	const progressContent = await getProgress(projectName, repoRoot, prdName);
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
 * Append findings to both the global project-level and per-PRD findings.md files
 */
export async function appendToFindings(
	projectName: string,
	repoRoot: string,
	content: string,
	prdName?: string,
): Promise<void> {
	if (!content.trim()) return;

	// Always append to global project-level findings
	const globalPath = join(getStateDir(projectName, repoRoot), "findings.md");
	const globalExisting = existsSync(globalPath)
		? await readFile(globalPath, "utf-8")
		: "# Ralph Findings\n\n";
	await atomicWrite(globalPath, globalExisting + content);

	// Also write per-PRD findings if prdName given
	if (prdName) {
		const prdPath = getPRDPath(projectName, repoRoot, prdName);
		if (!prdPath) throw new Error(`PRD not found: ${prdName}`);
		const findingsPath = join(prdPath, "findings.md");
		const existing = existsSync(findingsPath)
			? await readFile(findingsPath, "utf-8")
			: "# Ralph Findings\n\n";
		await atomicWrite(findingsPath, existing + content);
	}
}

/**
 * Extract findings from a PRD and append to findings.md
 * If agentConfig is provided, uses LLM to extract findings.
 * Otherwise falls back to regex-based extraction.
 */
export async function extractAndSaveFindings(
	projectName: string,
	repoRoot: string,
	prdName: string,
	providerVariant?: ProviderVariantConfig,
	runAgentFn?: (
		prompt: string,
		config: ProviderVariantConfig,
	) => Promise<{ output: string; exitCode: number }>,
): Promise<void> {
	let findings: string;

	if (providerVariant && runAgentFn) {
		// Use LLM-based extraction
		const { generateFindingsExtractionPrompt } = await import("./prompt.js");
		const prompt = await generateFindingsExtractionPrompt(projectName, repoRoot, prdName);
		const { output } = await runAgentFn(prompt, providerVariant);

		// Extract markdown from output (agent may include extra text)
		const markdownMatch = output.match(/## \[\d{4}-\d{2}-\d{2}\][\s\S]*?(?=\n## \[|$)/);
		findings = markdownMatch ? `${markdownMatch[0]}\n\n` : output;
	} else {
		// Fall back to regex-based extraction
		findings = await extractFindings(projectName, repoRoot, prdName);
	}

	await appendToFindings(projectName, repoRoot, findings, prdName);
}

/**
 * Get the next fix story ID for a PRD
 */
export async function getNextFixStoryId(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	const fixStories = prd.stories.filter((s) => s.id.startsWith("FIX-"));
	const maxNum = fixStories.reduce((max, s) => {
		const num = Number.parseInt(s.id.replace("FIX-", ""), 10);
		return Number.isNaN(num) ? max : Math.max(max, num);
	}, 0);
	return `FIX-${String(maxNum + 1).padStart(3, "0")}`;
}

/**
 * Add a fix story to a PRD based on QA failures.
 * Emits a story file at `stories/<id>.md` and records `promptPath` on the story.
 */
export async function addFixStory(
	projectName: string,
	repoRoot: string,
	prdName: string,
	issues: string[],
	qaResultsPath: string,
): Promise<string> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	const storyId = await getNextFixStoryId(projectName, repoRoot, prdName);
	const date = new Date().toISOString().split("T")[0];
	const prdDir = getPRDPath(projectName, repoRoot, prdName);
	if (!prdDir) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	const promptPath = `stories/${storyId}.md`;
	const storyFilePath = join(prdDir, promptPath);
	const storyDir = join(prdDir, "stories");
	mkdirSync(storyDir, { recursive: true });

	const frontmatter = [
		"---",
		`id: ${storyId}`,
		`title: Fix bugs from QA (${date})`,
		"priority: 1",
		"dependencies: []",
		"---",
		"",
	].join("\n");

	const body = `## Goal
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

	await writeFile(storyFilePath, frontmatter + body);

	const newStory: Story = {
		id: storyId,
		title: `Fix bugs from QA (${date})`,
		status: "pending",
		priority: 1,
		promptPath,
		questions: [],
	};

	prd.stories.push(newStory);
	await savePRD(projectName, repoRoot, prdName, prd);

	return storyId;
}

/**
 * Get the QA results directory path for a PRD
 */
export function getQAResultsDir(
	projectName: string,
	repoRoot: string,
	prdName: string,
): string | null {
	const prdPath = getPRDPath(projectName, repoRoot, prdName);
	if (!prdPath) return null;
	return join(prdPath, "qa-results");
}

/**
 * Clear the QA results directory for a PRD
 */
export async function clearQAResults(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<void> {
	const qaResultsDir = getQAResultsDir(projectName, repoRoot, prdName);
	if (!qaResultsDir) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	if (existsSync(qaResultsDir)) {
		rmSync(qaResultsDir, { recursive: true });
	}

	// Recreate empty directory structure
	mkdirSync(qaResultsDir, { recursive: true });
	mkdirSync(join(qaResultsDir, "screenshots"), { recursive: true });
	mkdirSync(join(qaResultsDir, "api-responses"), { recursive: true });
}

/**
 * Resolve the absolute path to a story's markdown file.
 */
export function getStoryFilePath(
	projectName: string,
	repoRoot: string,
	prdName: string,
	story: Story,
): string {
	const prdPath = getPRDPath(projectName, repoRoot, prdName);
	if (!prdPath) {
		throw new Error(`PRD not found: ${prdName}`);
	}
	return join(prdPath, story.promptPath);
}

/**
 * Read the `## Acceptance Criteria` section from a story markdown file.
 * Returns an array of criterion lines with leading list/checkbox markers stripped.
 * Throws when the section is missing or empty — acceptance criteria must live
 * in the story file.
 */
export function readStoryAcceptanceCriteria(storyFilePath: string): string[] {
	const content = readFileSync(storyFilePath, "utf-8");
	const headingRe = /^##\s+Acceptance Criteria\s*$/im;
	const match = content.match(headingRe);
	if (!match || match.index === undefined) {
		throw new Error(`Story file ${storyFilePath} is missing '## Acceptance Criteria' section.`);
	}
	const after = content.slice(match.index + match[0].length);
	const nextHeading = after.search(/^##\s+/m);
	const block = nextHeading === -1 ? after : after.slice(0, nextHeading);
	const items: string[] = [];
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const stripped = line
			.replace(/^[-*+]\s*/, "")
			.replace(/^\[[ xX]\]\s*/, "")
			.trim();
		if (!stripped) continue;
		items.push(stripped);
	}
	if (items.length === 0) {
		throw new Error(
			`Story file ${storyFilePath} has an '## Acceptance Criteria' section but no items.`,
		);
	}
	return items;
}
