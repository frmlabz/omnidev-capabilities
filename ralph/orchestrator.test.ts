/**
 * Tests for Ralph orchestration engine
 */

import { afterEach, beforeEach, it } from "bun:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createEngine,
	ensureDirectories,
	getAgentExecutor,
	getStatusDir,
	loadConfig,
} from "./lib/index.js";
import type { PRD, PRDStatus } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

const PROJECT_NAME = "test";
let REPO_ROOT = "";
let testDir: string;
let originalXdg: string | undefined;
let originalCwd: string;

const MOCK_CONFIG = `[ralph]
project_name = "test"
default_provider_variant = "test"
default_iterations = 5

[ralph.provider_variants.test]
command = "echo"
args = ["test output"]

[ralph.provider_variants.claude]
command = "npx"
args = ["-y", "@anthropic-ai/claude-code", "--model", "sonnet", "-p"]
`;

const LOCAL_OVERRIDE_CONFIG = `[ralph]
default_provider_variant = "claude"

[ralph.provider_variants.test]
args = ["local output"]

[ralph.docs]
path = "guides"
`;

const LOCAL_ONLY_CONFIG = `[ralph]
project_name = "local-test"
default_provider_variant = "local"
default_iterations = 7

[ralph.provider_variants.local]
command = "printf"
args = ["local"]
`;

function prepareReviewableFeatureBranch(repoRoot: string): void {
	writeFileSync(join(repoRoot, "tracked.txt"), "base\n");
	execSync("git add tracked.txt", { cwd: repoRoot });
	execSync('git commit -m "base tracked file" -q', { cwd: repoRoot });
	execSync("git branch -M main", { cwd: repoRoot });
	execSync("git checkout -q -b feature/review-skip", { cwd: repoRoot });
	writeFileSync(join(repoRoot, "tracked.txt"), "feature change\n");
	execSync("git add tracked.txt", { cwd: repoRoot });
	execSync('git commit -m "feature change" -q', { cwd: repoRoot });
}

// Helper to create a PRD directly
async function createTestPRD(
	name: string,
	options: Partial<PRD> = {},
	status: PRDStatus = "pending",
): Promise<void> {
	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, status), name);
	mkdirSync(prdDir, { recursive: true });

	const prd: PRD = {
		name,
		description: options.description ?? "Test PRD",
		createdAt: options.createdAt ?? new Date().toISOString(),
		stories: options.stories ?? [],
		...(options.dependencies && { dependencies: options.dependencies }),
	};

	await writeFile(join(prdDir, "prd.json"), JSON.stringify(prd, null, 2));
	await writeFile(
		join(prdDir, "progress.txt"),
		"## Codebase Patterns\n\n---\n\n## Progress Log\n\n",
	);
	await writeFile(join(prdDir, "spec.md"), "# Test Spec\n\nTest content");

	// Emit a story markdown file for every story so downstream code that reads
	// `stories/<id>.md` can find one (matches the new FR-1 layout).
	if (prd.stories.length > 0) {
		mkdirSync(join(prdDir, "stories"), { recursive: true });
		for (const story of prd.stories) {
			const storyPath = join(prdDir, story.promptPath);
			await writeFile(
				storyPath,
				`# ${story.id}: ${story.title}\n\n## Acceptance Criteria\n- [ ] Done\n`,
			);
		}
	}
}

beforeEach(() => {
	testDir = createTmpTestDir("ralph-test");
	originalCwd = process.cwd();
	process.chdir(testDir);
	execSync("git init -q", { cwd: testDir });
	execSync("git commit --allow-empty -m init -q", { cwd: testDir });
	REPO_ROOT = testDir;
	originalXdg = process.env["XDG_STATE_HOME"];
	process.env["XDG_STATE_HOME"] = testDir;
	ensureDirectories(PROJECT_NAME, REPO_ROOT);
	writeFileSync(join(testDir, "omni.toml"), MOCK_CONFIG);
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalXdg !== undefined) {
		process.env["XDG_STATE_HOME"] = originalXdg;
	} else {
		delete process.env["XDG_STATE_HOME"];
	}
	cleanupTmpTestDir(testDir);
});

it("loads valid config", async () => {
	const result = await loadConfig();
	assert.ok(result.ok);
	const config = result.data!;

	assert.strictEqual(config.default_provider_variant, "test");
	assert.strictEqual(config.default_iterations, 5);
	assert.deepStrictEqual(config.provider_variants["test"], {
		command: "echo",
		args: ["test output"],
	});
});

it("returns error if config doesn't exist", async () => {
	rmSync(join(testDir, "omni.toml"));

	const result = await loadConfig();
	assert.ok(!result.ok);
	assert.ok(result.error!.message.includes("Configuration file not found"));
});

it("returns error if config is invalid", async () => {
	writeFileSync(join(testDir, "omni.toml"), "invalid toml");

	const result = await loadConfig();
	assert.ok(!result.ok);
});

it("parses multiple provider variants", async () => {
	const result = await loadConfig();
	assert.ok(result.ok);
	const config = result.data!;

	assert.ok(config.provider_variants["test"] !== undefined);
	assert.ok(config.provider_variants["claude"] !== undefined);
	assert.strictEqual(config.provider_variants["claude"]?.command, "npx");
});

it("merges omni.local.toml over omni.toml", async () => {
	writeFileSync(join(testDir, "omni.local.toml"), LOCAL_OVERRIDE_CONFIG);

	const result = await loadConfig();
	assert.ok(result.ok);
	const config = result.data!;

	assert.strictEqual(config.default_provider_variant, "claude");
	assert.deepStrictEqual(config.provider_variants["test"], {
		command: "echo",
		args: ["local output"],
	});
	assert.strictEqual(config.docs?.path, "guides");
	assert.ok(config.provider_variants["claude"] !== undefined);
});

it("loads review todo_file config", async () => {
	writeFileSync(
		join(testDir, "omni.toml"),
		`${MOCK_CONFIG}

[ralph.review]
todo_file = ".ralph-review-todo.md"
`,
	);

	const result = await loadConfig();
	assert.ok(result.ok);
	assert.strictEqual(result.data!.review?.todo_file, ".ralph-review-todo.md");
});

it("accepts Ralph config provided only by omni.local.toml", async () => {
	writeFileSync(join(testDir, "omni.toml"), '[workspace]\nname = "test"\n');
	writeFileSync(join(testDir, "omni.local.toml"), LOCAL_ONLY_CONFIG);

	const result = await loadConfig();
	assert.ok(result.ok);
	const config = result.data!;

	assert.strictEqual(config.project_name, "local-test");
	assert.strictEqual(config.default_provider_variant, "local");
	assert.strictEqual(config.default_iterations, 7);
	assert.deepStrictEqual(config.provider_variants["local"], {
		command: "printf",
		args: ["local"],
	});
});

it("spawns agent with prompt via AgentExecutor", async () => {
	const executor = getAgentExecutor();
	const agentConfig = {
		command: "echo",
		args: ["hello"],
	};

	const result = await executor.run("test prompt", agentConfig);

	assert.ok(result.output.includes("hello"));
	assert.strictEqual(result.exitCode, 0);
});

it("returns exit code on failure via AgentExecutor", async () => {
	const executor = getAgentExecutor();
	const agentConfig = {
		command: "false", // Command that always fails
		args: [],
	};

	const result = await executor.run("test", agentConfig);

	assert.strictEqual(result.exitCode, 1);
});

it("returns error when PRD doesn't exist", async () => {
	const engine = createEngine({ projectName: PROJECT_NAME, repoRoot: REPO_ROOT });

	const result = await engine.runDevelopment("nonexistent");

	assert.ok(!result.ok);
	assert.ok(result.error!.message.includes("nonexistent"));
});

it("stops when blocked stories exist", async () => {
	await createTestPRD("blocked-prd", {
		description: "Blocked PRD",
		stories: [
			{
				id: "US-001",
				title: "Blocked story",
				promptPath: "stories/US-001.md",
				status: "blocked",
				priority: 1,
				questions: ["What should I do?"],
			},
		],
	});

	const engine = createEngine({ projectName: PROJECT_NAME, repoRoot: REPO_ROOT });
	const result = await engine.runDevelopment("blocked-prd");

	assert.ok(result.ok);
	assert.strictEqual(result.data!.outcome, "blocked");
});

it("completes when no stories remain", async () => {
	await createTestPRD("completed-prd", {
		description: "Completed PRD",
		stories: [
			{
				id: "US-001",
				title: "Done story",
				promptPath: "stories/US-001.md",
				status: "completed",
				priority: 1,
				questions: [],
			},
		],
	});

	const engine = createEngine({ projectName: PROJECT_NAME, repoRoot: REPO_ROOT });
	const result = await engine.runDevelopment("completed-prd");

	assert.ok(result.ok);
	assert.strictEqual(result.data!.outcome, "moved_to_qa");
});

it("skips review after a failed QA cycle even if qaCaughtIssue was dropped from prd.json", async () => {
	prepareReviewableFeatureBranch(REPO_ROOT);
	await createTestPRD(
		"fix-cycle-prd",
		{
			description: "PRD resuming after failed QA",
			stories: [
				{
					id: "US-001",
					title: "Original work",
					promptPath: "stories/US-001.md",
					status: "completed",
					priority: 1,
					questions: [],
				},
				{
					id: "FIX-001",
					title: "Fix bugs from QA",
					promptPath: "stories/FIX-001.md",
					status: "completed",
					priority: 1,
					questions: [],
				},
			],
		},
		"in_progress",
	);

	const events: Array<{ type: string; message?: string; phase?: string }> = [];
	const mockAgentExecutor = {
		async run() {
			return {
				output: "<review-result>APPROVE</review-result>",
				exitCode: 0,
				aborted: false,
			};
		},
		parseTokenUsage() {
			return {};
		},
		hasCompletionSignal(output: string) {
			return output.includes("<promise>COMPLETE</promise>");
		},
		parseStatus() {
			return null;
		},
	};

	const engine = createEngine({
		projectName: PROJECT_NAME,
		repoRoot: REPO_ROOT,
		agentExecutor: mockAgentExecutor as never,
	});
	const result = await engine.runDevelopment("fix-cycle-prd", {
		onEvent: (event) => events.push(event),
	});

	assert.ok(result.ok);
	assert.strictEqual(result.data!.outcome, "moved_to_qa");
	assert.ok(
		events.some(
			(event) =>
				event.type === "log" &&
				event.message?.includes("Skipping full review pipeline because this PRD has FIX stories"),
		),
	);
	assert.ok(!events.some((event) => event.type === "review_start"));
});
