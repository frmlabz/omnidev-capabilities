import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import {
	ensureDirectories,
	generateSimpleVerification,
	generateTestPrompt,
	generateVerificationPrompt,
	getStatusDir,
} from "./lib/index.js";
import type { PRD, RalphConfig } from "./lib/types.js";

const PROJECT_NAME = "test";
const REPO_ROOT = "/test-repo";
let testDir: string;
let originalXdg: string | undefined;

async function createTestPRD(name: string, prd: Partial<PRD> = {}): Promise<void> {
	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "testing"), name);
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
}

beforeEach(() => {
	testDir = join(
		process.cwd(),
		".test-ralph-verification",
		`test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
	);
	mkdirSync(testDir, { recursive: true });
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
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

it("adds documentation verification requirements to generated verification prompts", async () => {
	await createTestPRD("verify-docs", {
		description: "Verify docs are covered",
		stories: [
			{
				id: "US-001",
				title: "Ship feature",
				acceptanceCriteria: ["Feature works", "Docs updated"],
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
				acceptanceCriteria: ["Feature works"],
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

it("requires documentation checks in the testing prompt", async () => {
	await createTestPRD("test-docs", {
		description: "Testing should verify docs",
		stories: [
			{
				id: "US-001",
				title: "Ship feature",
				acceptanceCriteria: ["Feature works"],
				status: "completed",
				priority: 1,
				questions: [],
			},
		],
	});

	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "testing"), "test-docs");
	await writeFile(
		join(prdDir, "verification.md"),
		"# Verification Checklist: test-docs\n\n## Functional Tests\n- [ ] Feature works\n",
	);

	const config: RalphConfig = {
		project_name: PROJECT_NAME,
		default_agent: "test",
		default_iterations: 5,
		agents: {
			test: {
				command: "echo",
				args: ["test"],
			},
		},
	};

	const prompt = await generateTestPrompt(PROJECT_NAME, REPO_ROOT, "test-docs", config);

	assert.ok(prompt.includes("Documentation: docs/**/*.md"));
	assert.ok(prompt.includes("Verify documentation completeness"));
	assert.ok(
		prompt.includes(
			"PRD_VERIFIED only if happy path, documentation checks, and edge cases all pass.",
		),
	);
});
