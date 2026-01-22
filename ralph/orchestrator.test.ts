/**
 * Tests for Ralph orchestrator
 */

import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadRalphConfig, runAgent } from "./orchestrator.ts";
import type { PRD } from "./types.ts";

const TEST_DIR = join(process.cwd(), ".test-ralph-orchestrator");
const RALPH_DIR = join(TEST_DIR, ".omni/state/ralph");
const CONFIG_PATH = join(RALPH_DIR, "config.toml");
const PRDS_DIR = join(RALPH_DIR, "prds");

const MOCK_CONFIG = `[ralph]
default_agent = "test"
default_iterations = 5
auto_archive = false

[agents.test]
command = "echo"
args = ["test output"]

[agents.claude]
command = "npx"
args = ["-y", "@anthropic-ai/claude-code", "--model", "sonnet", "-p"]
`;

// Helper to create a PRD directly
async function createTestPRD(name: string, options: Partial<PRD> = {}): Promise<void> {
	const prdDir = join(PRDS_DIR, name);
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
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	mkdirSync(RALPH_DIR, { recursive: true });
	mkdirSync(PRDS_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, MOCK_CONFIG);
});

afterEach(() => {
	process.chdir(join(TEST_DIR, ".."));
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true, force: true });
	}
});

describe("loadRalphConfig", () => {
	it("loads valid config", async () => {
		const config = await loadRalphConfig();

		assert.strictEqual(config.default_agent, "test");
		assert.strictEqual(config.default_iterations, 5);
		assert.strictEqual(config.auto_archive, false);
		assert.deepStrictEqual(config.agents["test"], {
			command: "echo",
			args: ["test output"],
		});
	});

	it("throws if config doesn't exist", async () => {
		rmSync(CONFIG_PATH);

		await assert.rejects(loadRalphConfig(), /Ralph config not found/);
	});

	it("throws if config is invalid", async () => {
		writeFileSync(CONFIG_PATH, "invalid toml");

		await assert.rejects(loadRalphConfig());
	});

	it("parses multiple agents", async () => {
		const config = await loadRalphConfig();

		assert.ok(config.agents["test"] !== undefined);
		assert.ok(config.agents["claude"] !== undefined);
		assert.strictEqual(config.agents["claude"]?.command, "npx");
	});
});

describe("runAgent", () => {
	it("spawns agent with prompt", async () => {
		const agentConfig = {
			command: "echo",
			args: ["hello"],
		};

		const result = await runAgent("test prompt", agentConfig);

		assert.ok(result.output.includes("hello"));
		assert.strictEqual(result.exitCode, 0);
	});

	it("returns exit code on failure", async () => {
		const agentConfig = {
			command: "false", // Command that always fails
			args: [],
		};

		const result = await runAgent("test", agentConfig);

		assert.strictEqual(result.exitCode, 1);
	});
});

describe("runOrchestration", () => {
	it("throws if PRD doesn't exist", async () => {
		const { runOrchestration } = await import("./orchestrator.ts");

		await assert.rejects(runOrchestration("nonexistent"), /PRD not found: nonexistent/);
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

		const { runOrchestration } = await import("./orchestrator.ts");

		// Should stop immediately due to blocked story
		await runOrchestration("blocked-prd");

		// No crash = success
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

		const { runOrchestration } = await import("./orchestrator.ts");

		// Should complete immediately without running agent
		await runOrchestration("completed-prd");

		// No crash = success
	});
});
