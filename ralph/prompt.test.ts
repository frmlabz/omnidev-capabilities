/**
 * Tests for Ralph prompt generator
 */

import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "bun:test";
import { generatePrompt, getStatusDir, ensureDirectories } from "./lib/index.js";
import type { PRD, Story } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

const PROJECT_NAME = "test";
const REPO_ROOT = "/test-repo";
let testDir: string;
let originalXdg: string | undefined;

/**
 * Write a story markdown file under prdDir/stories/<id>.md with the given
 * acceptance criteria. Returns the relative promptPath.
 */
async function writeStoryFile(
	prdDir: string,
	story: Story,
	acceptanceCriteria: string[] = [],
): Promise<void> {
	const abs = join(prdDir, story.promptPath);
	mkdirSync(join(prdDir, "stories"), { recursive: true });
	const acBlock = acceptanceCriteria.length
		? acceptanceCriteria.map((ac) => `  - ${ac}`).join("\n")
		: "  - (none)";
	const content = `# ${story.id}: ${story.title}

## Acceptance Criteria
${acBlock}
`;
	await writeFile(abs, content);
}

// Helper to create a PRD directly
async function createTestPRD(name: string, prd: Partial<PRD> = {}): Promise<string> {
	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"), name);
	mkdirSync(prdDir, { recursive: true });

	const fullPRD: PRD = {
		name,
		description: prd.description ?? "Test PRD",
		createdAt: prd.createdAt ?? new Date().toISOString(),
		stories: prd.stories ?? [],
		...(prd.dependencies && { dependencies: prd.dependencies }),
	};

	await writeFile(join(prdDir, "prd.json"), JSON.stringify(fullPRD, null, 2));
	await writeFile(
		join(prdDir, "progress.txt"),
		"## Codebase Patterns\n\n---\n\n## Progress Log\n\n",
	);
	await writeFile(join(prdDir, "spec.md"), "# Test Spec\n\nTest specification content");

	return prdDir;
}

beforeEach(() => {
	testDir = createTmpTestDir("test-ralph-prompt");
	originalXdg = process.env["XDG_STATE_HOME"];
	process.env["XDG_STATE_HOME"] = testDir;
	ensureDirectories(PROJECT_NAME, REPO_ROOT);
});

afterEach(() => {
	if (originalXdg !== undefined) {
		process.env["XDG_STATE_HOME"] = originalXdg;
	} else {
		delete process.env["XDG_STATE_HOME"];
	}
	cleanupTmpTestDir(testDir);
});

it("generates prompt with PRD context", async () => {
	const prd: PRD = {
		name: "test-project",
		description: "Test project description",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-001",
		title: "Test Story",
		promptPath: "stories/US-001.md",
		status: "pending",
		priority: 1,
		questions: [],
	};

	const prdDir = await createTestPRD("test-project", prd);
	await writeStoryFile(prdDir, story, ["Feature works", "Tests pass"]);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "test-project");

	assert.ok(prompt.includes("test-project"));
	assert.ok(prompt.includes("Test project description"));
	assert.ok(prompt.includes("US-001"));
	assert.ok(prompt.includes("Test Story"));
	assert.ok(prompt.includes("Feature works"));
	assert.ok(prompt.includes("Tests pass"));
});

it("references the spec file path in the prompt header", async () => {
	const prd: PRD = {
		name: "spec-test",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-002",
		title: "Story",
		promptPath: "stories/US-002.md",
		status: "pending",
		priority: 1,
		questions: [],
	};

	const prdDir = await createTestPRD("spec-test", prd);
	await writeStoryFile(prdDir, story);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "spec-test");

	assert.ok(prompt.includes("spec.md"));
});

it("includes recent progress", async () => {
	const prd: PRD = {
		name: "progress-test",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-002",
		title: "Story",
		promptPath: "stories/US-002.md",
		status: "pending",
		priority: 1,
		questions: [],
	};

	const prdDir = await createTestPRD("progress-test", prd);
	await writeStoryFile(prdDir, story);

	// Add progress
	const { appendProgress } = await import("./lib/index.js");
	await appendProgress(
		PROJECT_NAME,
		REPO_ROOT,
		"progress-test",
		"## Test Progress\n- Did something",
	);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "progress-test");

	assert.ok(prompt.includes("Test Progress"));
	assert.ok(prompt.includes("Did something"));
});

it("includes story file content verbatim", async () => {
	const prd: PRD = {
		name: "patterns-test",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-003",
		title: "Story",
		promptPath: "stories/US-003.md",
		status: "pending",
		priority: 1,
		questions: [],
	};

	const prdDir = await createTestPRD("patterns-test", prd);
	const storyPath = join(prdDir, story.promptPath);
	mkdirSync(join(prdDir, "stories"), { recursive: true });
	await writeFile(
		storyPath,
		"# US-003\n\n## Scope\nCustom scope section.\n\n## Acceptance Criteria\n- Uses writeFile()\n- Uses strict types\n",
	);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "patterns-test");

	assert.ok(prompt.includes("Custom scope section."));
	assert.ok(prompt.includes("Uses writeFile()"));
	assert.ok(prompt.includes("Uses strict types"));
});

it("handles empty progress gracefully", async () => {
	const prd: PRD = {
		name: "no-patterns",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-004",
		title: "Story",
		promptPath: "stories/US-004.md",
		status: "pending",
		priority: 1,
		questions: [],
	};

	const prdDir = await createTestPRD("no-patterns", prd);
	await writeStoryFile(prdDir, story);

	// Overwrite progress.txt to be empty so the prompt uses the fallback text.
	const progressPath = join(prdDir, "progress.txt");
	await writeFile(progressPath, "");

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "no-patterns");

	assert.ok(prompt.includes("(no progress yet)"));
});

it("formats acceptance criteria from the story file", async () => {
	const prd: PRD = {
		name: "criteria-test",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-005",
		title: "Story",
		promptPath: "stories/US-005.md",
		status: "pending",
		priority: 1,
		questions: [],
	};

	const prdDir = await createTestPRD("criteria-test", prd);
	await writeStoryFile(prdDir, story, ["First criterion", "Second criterion"]);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "criteria-test");

	assert.ok(prompt.includes("First criterion"));
	assert.ok(prompt.includes("Second criterion"));
});

it("includes other stories for context", async () => {
	const prd: PRD = {
		name: "multi-story",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [
			{
				id: "US-001",
				title: "First Story",
				promptPath: "stories/US-001.md",
				status: "completed",
				priority: 1,
				questions: [],
			},
			{
				id: "US-002",
				title: "Second Story",
				promptPath: "stories/US-002.md",
				status: "pending",
				priority: 2,
				questions: [],
			},
		],
	};

	const story = prd.stories[1];
	assert.ok(story !== undefined);

	const prdDir = await createTestPRD("multi-story", prd);
	await writeStoryFile(prdDir, prd.stories[0]!);
	await writeStoryFile(prdDir, story);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "multi-story");

	assert.ok(prompt.includes("US-001: First Story [completed]"));
});

it("includes documentation requirements in the implementation prompt", async () => {
	const prd: PRD = {
		name: "docs-required",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-006",
		title: "Documented Story",
		promptPath: "stories/US-006.md",
		status: "pending",
		priority: 1,
		questions: [],
	};

	const prdDir = await createTestPRD("docs-required", prd);
	await writeStoryFile(prdDir, story, ["Docs stay up to date"]);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "docs-required");

	assert.ok(prompt.includes("docs/**/*.md"));
	assert.ok(prompt.includes("Documentation updates:"));
	assert.ok(prompt.includes("Documentation is required work"));
});
