import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sync } from "./sync.ts";

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

	it("creates .omni/state/ralph directory structure", async () => {
		await sync();

		assert.strictEqual(existsSync(".omni/state/ralph"), true);
		assert.strictEqual(existsSync(".omni/state/ralph/prds"), true);
		assert.strictEqual(existsSync(".omni/state/ralph/completed-prds"), true);
	});

	it("creates default config.toml if not exists", async () => {
		await sync();

		assert.strictEqual(existsSync(".omni/state/ralph/config.toml"), true);

		const content = await readFile(".omni/state/ralph/config.toml", "utf-8");
		assert.ok(content.includes("[ralph]"));
		assert.ok(content.includes('default_agent = "claude"'));
		assert.ok(content.includes("default_iterations = 10"));
		assert.ok(content.includes("auto_archive = true"));
		assert.ok(content.includes("[agents.claude]"));
		assert.ok(content.includes("[agents.codex]"));
		assert.ok(content.includes("[agents.amp]"));
	});

	it("does not overwrite existing config.toml", async () => {
		mkdirSync(".omni/state/ralph", { recursive: true });
		await writeFile(".omni/state/ralph/config.toml", "[ralph]\ncustom = true");

		await sync();

		const content = await readFile(".omni/state/ralph/config.toml", "utf-8");
		assert.strictEqual(content, "[ralph]\ncustom = true");
		assert.ok(!content.includes("default_agent"));
	});

	it("is idempotent - safe to run multiple times", async () => {
		await sync();
		await sync();
		await sync();

		assert.strictEqual(existsSync(".omni/state/ralph"), true);
		assert.strictEqual(existsSync(".omni/state/ralph/prds"), true);
		assert.strictEqual(existsSync(".omni/state/ralph/completed-prds"), true);
		assert.strictEqual(existsSync(".omni/state/ralph/config.toml"), true);
	});

	it("handles existing directory structure gracefully", async () => {
		mkdirSync(".omni/state/ralph/prds", { recursive: true });
		mkdirSync(".omni/state/ralph/completed-prds", { recursive: true });

		await sync();

		assert.strictEqual(existsSync(".omni/state/ralph"), true);
		assert.strictEqual(existsSync(".omni/state/ralph/prds"), true);
		assert.strictEqual(existsSync(".omni/state/ralph/completed-prds"), true);
	});

	it("preserves existing PRDs and files", async () => {
		mkdirSync(".omni/state/ralph/prds/my-prd", { recursive: true });
		await writeFile(".omni/state/ralph/prds/my-prd/prd.json", '{"name":"my-prd"}');

		await sync();

		assert.strictEqual(existsSync(".omni/state/ralph/prds/my-prd/prd.json"), true);
		const content = await readFile(".omni/state/ralph/prds/my-prd/prd.json", "utf-8");
		assert.strictEqual(content, '{"name":"my-prd"}');
	});
});
