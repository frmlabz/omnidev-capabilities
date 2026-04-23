import { afterEach, beforeEach, it } from "bun:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sync } from "./sync.ts";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

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
`;

beforeEach(() => {
	testDir = createTmpTestDir("test-ralph-sync");
	originalCwd = process.cwd();
	process.chdir(testDir);
	execSync("git init -q", { cwd: testDir });
	originalXdg = process.env["XDG_STATE_HOME"];
	process.env["XDG_STATE_HOME"] = testDir;
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

it("creates XDG state directory structure", async () => {
	await sync();

	// sync uses git rev-parse for repoRoot, which may differ from our constant,
	// so verify via the dirs that ensureStateDirs creates under XDG_STATE_HOME
	assert.strictEqual(existsSync(join(testDir, "omnidev", "ralph")), true);
});

it("is idempotent - safe to run multiple times", async () => {
	await sync();
	await sync();
	await sync();

	assert.strictEqual(existsSync(join(testDir, "omnidev", "ralph")), true);
});

it("does nothing without config", async () => {
	rmSync(join(testDir, "omni.toml"));

	await sync();

	// No state dirs created
	assert.strictEqual(existsSync(join(testDir, "omnidev")), false);
});
