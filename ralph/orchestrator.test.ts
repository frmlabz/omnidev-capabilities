/**
 * Tests for Ralph orchestration engine
 */

import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
	testDir = join(
		"/tmp",
		"ralph-test",
		`test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
	);
	mkdirSync(testDir, { recursive: true });
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
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
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
