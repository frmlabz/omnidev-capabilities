import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "bun:test";
import {
	ensureDirectories,
	generateQAPrompt,
	generateSimpleVerification,
	generateVerificationPrompt,
	getStatusDir,
} from "./lib/index.js";
import type { PRD, RalphConfig } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

const PROJECT_NAME = "test";
const REPO_ROOT = "/test-repo";
let testDir: string;
let originalXdg: string | undefined;

/**
 * Write a story markdown file with `## Acceptance Criteria` under the PRD dir.
 */
async function writeStoryFile(
	prdDir: string,
	storyId: string,
	title: string,
	acs: string[],
): Promise<string> {
	const relPath = `stories/${storyId}.md`;
	const absPath = join(prdDir, relPath);
	mkdirSync(join(prdDir, "stories"), { recursive: true });
	const acBlock = acs.map((ac) => `- [ ] ${ac}`).join("\n");
	await writeFile(absPath, `# ${storyId}: ${title}\n\n## Acceptance Criteria\n${acBlock}\n`);
	return relPath;
}

async function createTestPRD(name: string, prd: Partial<PRD> = {}): Promise<void> {
	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "qa"), name);
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
		"## Codebase Patterns\n\n---\n\n## Progress Log\n\nImplemented feature.\n",
	);
	await writeFile(join(prdDir, "spec.md"), "# Test Spec\n\nTest specification content");

	// Write story files referenced by the PRD stories.
	for (const story of fullPRD.stories) {
		await writeStoryFile(prdDir, story.id, story.title, ["Feature works"]);
	}
}

beforeEach(() => {
	testDir = createTmpTestDir("test-ralph-verification");
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

it("adds documentation verification requirements to generated verification prompts", async () => {
	await createTestPRD("verify-docs", {
		description: "Verify docs are covered",
		stories: [
			{
				id: "US-001",
				title: "Ship feature",
				promptPath: "stories/US-001.md",
				status: "completed",
				priority: 1,
				questions: [],
			},
		],
	});

	const prompt = await generateVerificationPrompt(PROJECT_NAME, REPO_ROOT, "verify-docs");

	assert.ok(prompt.includes("## Documentation Verification"));
	assert.ok(prompt.includes("docs/**/*.md"));
});

it("includes documentation checks in the simple verification fallback", async () => {
	await createTestPRD("simple-verify-docs", {
		description: "Fallback verification",
		stories: [
			{
				id: "US-001",
				title: "Ship feature",
				promptPath: "stories/US-001.md",
				status: "completed",
				priority: 1,
				questions: [],
			},
		],
	});

	const content = await generateSimpleVerification(PROJECT_NAME, REPO_ROOT, "simple-verify-docs");

	assert.ok(content.includes("## Documentation Verification"));
	assert.ok(content.includes("docs/**/*.md"));
});

it("requires documentation checks in the QA prompt", async () => {
	await createTestPRD("test-docs", {
		description: "QA should verify docs",
		stories: [
			{
				id: "US-001",
				title: "Ship feature",
				promptPath: "stories/US-001.md",
				status: "completed",
				priority: 1,
				questions: [],
			},
		],
	});

	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "qa"), "test-docs");
	await writeFile(
		join(prdDir, "verification.md"),
		"# Verification Checklist: test-docs\n\n## Functional Tests\n- [ ] Feature works\n",
	);

	const config: RalphConfig = {
		project_name: PROJECT_NAME,
		default_provider_variant: "test",
		default_iterations: 5,
		provider_variants: {
			test: {
				command: "echo",
				args: ["test"],
			},
		},
	};

	const prompt = await generateQAPrompt(PROJECT_NAME, REPO_ROOT, "test-docs", config);

	assert.ok(prompt.includes("docs/**/*.md"));
	assert.ok(prompt.includes("Verify documentation completeness"));
	assert.ok(
		prompt.includes(
			"PRD_VERIFIED only if happy path, documentation checks, and edge cases all pass.",
		),
	);
});
