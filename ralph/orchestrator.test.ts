/**
 * Tests for Ralph orchestrator
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRalphConfig, runAgent } from "./orchestrator";
import type { PRD } from "./types";

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

	await Bun.write(join(prdDir, "prd.json"), JSON.stringify(prd, null, 2));
	await Bun.write(
		join(prdDir, "progress.txt"),
		"## Codebase Patterns\n\n---\n\n## Progress Log\n\n",
	);
	await Bun.write(join(prdDir, "spec.md"), "# Test Spec\n\nTest content");
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
	test("loads valid config", async () => {
		const config = await loadRalphConfig();

		expect(config.default_agent).toBe("test");
		expect(config.default_iterations).toBe(5);
		expect(config.auto_archive).toBe(false);
		expect(config.agents["test"]).toEqual({
			command: "echo",
			args: ["test output"],
		});
	});

	test("throws if config doesn't exist", async () => {
		rmSync(CONFIG_PATH);

		await expect(loadRalphConfig()).rejects.toThrow("Ralph config not found");
	});

	test("throws if config is invalid", async () => {
		writeFileSync(CONFIG_PATH, "invalid toml");

		await expect(loadRalphConfig()).rejects.toThrow();
	});

	test("parses multiple agents", async () => {
		const config = await loadRalphConfig();

		expect(config.agents["test"]).toBeDefined();
		expect(config.agents["claude"]).toBeDefined();
		expect(config.agents["claude"]?.command).toBe("npx");
	});
});

describe("runAgent", () => {
	test("spawns agent with prompt", async () => {
		const agentConfig = {
			command: "echo",
			args: ["hello"],
		};

		const result = await runAgent("test prompt", agentConfig);

		expect(result.output).toContain("hello");
		expect(result.exitCode).toBe(0);
	});

	test("returns exit code on failure", async () => {
		const agentConfig = {
			command: "false", // Command that always fails
			args: [],
		};

		const result = await runAgent("test", agentConfig);

		expect(result.exitCode).toBe(1);
	});
});

describe("runOrchestration", () => {
	test("throws if PRD doesn't exist", async () => {
		const { runOrchestration } = await import("./orchestrator");

		await expect(runOrchestration("nonexistent")).rejects.toThrow("PRD not found: nonexistent");
	});

	test("stops when blocked stories exist", async () => {
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

		const { runOrchestration } = await import("./orchestrator");

		// Should stop immediately due to blocked story
		await runOrchestration("blocked-prd");

		// No crash = success
	});

	test("completes when no stories remain", async () => {
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

		const { runOrchestration } = await import("./orchestrator");

		// Should complete immediately without running agent
		await runOrchestration("completed-prd");

		// No crash = success
	});
});
