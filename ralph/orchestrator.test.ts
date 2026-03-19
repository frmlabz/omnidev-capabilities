/**
 * Tests for Ralph orchestration engine
 */

import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import {
	loadConfig,
	getAgentExecutor,
	createEngine,
	getStatusDir,
	ensureDirectories,
} from "./lib/index.js";
import type { PRD } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

const PROJECT_NAME = "test";
let REPO_ROOT = "";
let testDir: string;
let originalXdg: string | undefined;
let originalCwd: string;

const MOCK_CONFIG = `[ralph]
project_name = "test"
default_agent = "test"
default_iterations = 5

[ralph.agents.test]
command = "echo"
args = ["test output"]

[ralph.agents.claude]
command = "npx"
args = ["-y", "@anthropic-ai/claude-code", "--model", "sonnet", "-p"]
`;

const LOCAL_OVERRIDE_CONFIG = `[ralph]
default_agent = "claude"

[ralph.agents.test]
args = ["local output"]

[ralph.docs]
path = "guides"
`;

const LOCAL_ONLY_CONFIG = `[ralph]
project_name = "local-test"
default_agent = "local"
default_iterations = 7

[ralph.agents.local]
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
	status: string = "pending",
): Promise<void> {
	const prdDir = join(
		getStatusDir(
			PROJECT_NAME,
			REPO_ROOT,
			status as "pending" | "in_progress" | "testing" | "completed",
		),
		name,
	);
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

	assert.strictEqual(config.default_agent, "test");
	assert.strictEqual(config.default_iterations, 5);
	assert.deepStrictEqual(config.agents["test"], {
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

it("parses multiple agents", async () => {
	const result = await loadConfig();
	assert.ok(result.ok);
	const config = result.data!;

	assert.ok(config.agents["test"] !== undefined);
	assert.ok(config.agents["claude"] !== undefined);
	assert.strictEqual(config.agents["claude"]?.command, "npx");
});

it("merges omni.local.toml over omni.toml", async () => {
	writeFileSync(join(testDir, "omni.local.toml"), LOCAL_OVERRIDE_CONFIG);

	const result = await loadConfig();
	assert.ok(result.ok);
	const config = result.data!;

	assert.strictEqual(config.default_agent, "claude");
	assert.deepStrictEqual(config.agents["test"], {
		command: "echo",
		args: ["local output"],
	});
	assert.strictEqual(config.docs?.path, "guides");
	assert.ok(config.agents["claude"] !== undefined);
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
	assert.strictEqual(config.default_agent, "local");
	assert.strictEqual(config.default_iterations, 7);
	assert.deepStrictEqual(config.agents["local"], {
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
				acceptanceCriteria: ["Done"],
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
				acceptanceCriteria: ["Done"],
				status: "completed",
				priority: 1,
				questions: [],
			},
		],
	});

	const engine = createEngine({ projectName: PROJECT_NAME, repoRoot: REPO_ROOT });
	const result = await engine.runDevelopment("completed-prd");

	assert.ok(result.ok);
	assert.strictEqual(result.data!.outcome, "moved_to_testing");
});

it("skips review after a failed test cycle even if testsCaughtIssue was dropped from prd.json", async () => {
	prepareReviewableFeatureBranch(REPO_ROOT);
	await createTestPRD(
		"fix-cycle-prd",
		{
			description: "PRD resuming after failed testing",
			stories: [
				{
					id: "US-001",
					title: "Original work",
					acceptanceCriteria: ["Done"],
					status: "completed",
					priority: 1,
					questions: [],
				},
				{
					id: "FIX-001",
					title: "Fix bugs from testing",
					acceptanceCriteria: ["Fix test failures"],
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
	assert.strictEqual(result.data!.outcome, "moved_to_testing");
	assert.ok(
		events.some(
			(event) =>
				event.type === "log" &&
				event.message?.includes("Skipping full review pipeline because this PRD has FIX stories"),
		),
	);
	assert.ok(!events.some((event) => event.type === "review_start"));
});
