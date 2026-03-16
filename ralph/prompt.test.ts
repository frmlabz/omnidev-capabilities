/**
 * Tests for Ralph prompt generator
 */

import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { generatePrompt, getStatusDir, ensureDirectories } from "./lib/index.js";
import type { PRD, Story } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

const PROJECT_NAME = "test";
const REPO_ROOT = "/test-repo";
let testDir: string;
let originalXdg: string | undefined;

// Helper to create a PRD directly
async function createTestPRD(name: string, prd: Partial<PRD> = {}): Promise<void> {
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
		acceptanceCriteria: ["Feature works", "Tests pass"],
		status: "pending",
		priority: 1,
		questions: [],
	};

	await createTestPRD("test-project", prd);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "test-project");

	assert.ok(prompt.includes("test-project"));
	assert.ok(prompt.includes("Test project description"));
	assert.ok(prompt.includes("US-001"));
	assert.ok(prompt.includes("Test Story"));
	assert.ok(prompt.includes("Feature works"));
	assert.ok(prompt.includes("Tests pass"));
});

it("includes spec content", async () => {
	const prd: PRD = {
		name: "spec-test",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-002",
		title: "Story",
		acceptanceCriteria: [],
		status: "pending",
		priority: 1,
		questions: [],
	};

	await createTestPRD("spec-test", prd);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "spec-test");

	assert.ok(prompt.includes("Test Spec"));
	assert.ok(prompt.includes("Test specification content"));
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
		acceptanceCriteria: [],
		status: "pending",
		priority: 1,
		questions: [],
	};

	await createTestPRD("progress-test", prd);

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

it("includes codebase patterns", async () => {
	const prd: PRD = {
		name: "patterns-test",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-003",
		title: "Story",
		acceptanceCriteria: [],
		status: "pending",
		priority: 1,
		questions: [],
	};

	await createTestPRD("patterns-test", prd);
	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"), "patterns-test");
	const progressPath = join(prdDir, "progress.txt");
	await writeFile(
		progressPath,
		"## Codebase Patterns\n- Use writeFile()\n- Use strict types\n\n---\n\n## Progress Log\n",
	);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "patterns-test");

	assert.ok(prompt.includes("Use writeFile()"));
	assert.ok(prompt.includes("Use strict types"));
});

it("handles empty patterns gracefully", async () => {
	const prd: PRD = {
		name: "no-patterns",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-004",
		title: "Story",
		acceptanceCriteria: [],
		status: "pending",
		priority: 1,
		questions: [],
	};

	await createTestPRD("no-patterns", prd);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "no-patterns");

	assert.ok(prompt.includes("None yet"));
});

it("formats acceptance criteria as bullet list", async () => {
	const prd: PRD = {
		name: "criteria-test",
		description: "Test",
		createdAt: "2026-01-09T00:00:00Z",
		stories: [],
	};

	const story: Story = {
		id: "US-005",
		title: "Story",
		acceptanceCriteria: ["First criterion", "Second criterion"],
		status: "pending",
		priority: 1,
		questions: [],
	};

	await createTestPRD("criteria-test", prd);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "criteria-test");

	assert.ok(prompt.includes("  - First criterion"));
	assert.ok(prompt.includes("  - Second criterion"));
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
				acceptanceCriteria: [],
				status: "completed",
				priority: 1,
				questions: [],
			},
			{
				id: "US-002",
				title: "Second Story",
				acceptanceCriteria: [],
				status: "pending",
				priority: 2,
				questions: [],
			},
		],
	};

	const story = prd.stories[1];
	assert.ok(story !== undefined);

	await createTestPRD("multi-story", prd);

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
		acceptanceCriteria: ["Docs stay up to date"],
		status: "pending",
		priority: 1,
		questions: [],
	};

	await createTestPRD("docs-required", prd);

	const prompt = await generatePrompt(PROJECT_NAME, REPO_ROOT, prd, story, "docs-required");

	assert.ok(prompt.includes("docs/**/*.md"));
	assert.ok(prompt.includes("Documentation updates:"));
	assert.ok(prompt.includes("Documentation is required work"));
});
