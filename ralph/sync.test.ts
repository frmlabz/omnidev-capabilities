import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { sync } from "./sync";

describe("Ralph sync hook", () => {
	const testDir = "test-ralph-sync";

	beforeEach(() => {
		// Create test directory
		mkdirSync(testDir, { recursive: true });
		// Change to test directory
		process.chdir(testDir);
	});

	afterEach(() => {
		// Change back to original directory
		process.chdir("..");
		// Clean up test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("creates .omni/state/ralph directory structure", async () => {
		await sync();

		expect(existsSync(".omni/state/ralph")).toBe(true);
		expect(existsSync(".omni/state/ralph/prds")).toBe(true);
		expect(existsSync(".omni/state/ralph/completed-prds")).toBe(true);
	});

	test("creates default config.toml if not exists", async () => {
		await sync();

		expect(existsSync(".omni/state/ralph/config.toml")).toBe(true);

		const content = await Bun.file(".omni/state/ralph/config.toml").text();
		expect(content).toContain("[ralph]");
		expect(content).toContain('default_agent = "claude"');
		expect(content).toContain("default_iterations = 10");
		expect(content).toContain("auto_archive = true");
		expect(content).toContain("[agents.claude]");
		expect(content).toContain("[agents.codex]");
		expect(content).toContain("[agents.amp]");
	});

	test("does not overwrite existing config.toml", async () => {
		mkdirSync(".omni/state/ralph", { recursive: true });
		await Bun.write(".omni/state/ralph/config.toml", "[ralph]\ncustom = true");

		await sync();

		const content = await Bun.file(".omni/state/ralph/config.toml").text();
		expect(content).toBe("[ralph]\ncustom = true");
		expect(content).not.toContain("default_agent");
	});

	test("is idempotent - safe to run multiple times", async () => {
		await sync();
		await sync();
		await sync();

		expect(existsSync(".omni/state/ralph")).toBe(true);
		expect(existsSync(".omni/state/ralph/prds")).toBe(true);
		expect(existsSync(".omni/state/ralph/completed-prds")).toBe(true);
		expect(existsSync(".omni/state/ralph/config.toml")).toBe(true);
	});

	test("handles existing directory structure gracefully", async () => {
		mkdirSync(".omni/state/ralph/prds", { recursive: true });
		mkdirSync(".omni/state/ralph/completed-prds", { recursive: true });

		await sync();

		expect(existsSync(".omni/state/ralph")).toBe(true);
		expect(existsSync(".omni/state/ralph/prds")).toBe(true);
		expect(existsSync(".omni/state/ralph/completed-prds")).toBe(true);
	});

	test("preserves existing PRDs and files", async () => {
		mkdirSync(".omni/state/ralph/prds/my-prd", { recursive: true });
		await Bun.write(".omni/state/ralph/prds/my-prd/prd.json", '{"name":"my-prd"}');

		await sync();

		expect(existsSync(".omni/state/ralph/prds/my-prd/prd.json")).toBe(true);
		const content = await Bun.file(".omni/state/ralph/prds/my-prd/prd.json").text();
		expect(content).toBe('{"name":"my-prd"}');
	});
});
