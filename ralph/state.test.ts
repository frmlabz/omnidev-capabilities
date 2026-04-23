/**
 * Tests for Ralph state management
 */

import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	appendProgress,
	ensureDirectories,
	extractFindings,
	findPRDLocation,
	getNextStory,
	getPRD,
	getProgress,
	getSpec,
	getStatusDir,
	hasBlockedStories,
	isPRDComplete,
	listPRDs,
	listPRDsByStatus,
	movePRD,
	updateLastRun,
	updatePRD,
	updateStoryStatus,
} from "./lib/index.js";
import type { PRD, PRDStatus } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

const PROJECT_NAME = "test";
const REPO_ROOT = "/test-repo";
let testDir: string;
let originalXdg: string | undefined;

async function createTestPRD(
	name: string,
	options: Partial<PRD> = {},
	status: PRDStatus = "pending",
): Promise<PRD> {
	const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, status), name);
	mkdirSync(prdDir, { recursive: true });

	const prd: PRD = {
		name,
		description: options.description ?? "Test PRD",
		createdAt: options.createdAt ?? new Date().toISOString(),
		stories: options.stories ?? [],
		...(options.dependencies && { dependencies: options.dependencies }),
		...(options.lastRun && { lastRun: options.lastRun }),
	};

	await writeFile(join(prdDir, "prd.json"), JSON.stringify(prd, null, 2));
	await writeFile(
		join(prdDir, "progress.txt"),
		"## Codebase Patterns\n\n---\n\n## Progress Log\n\n",
	);
	await writeFile(join(prdDir, "spec.md"), "# Test Spec\n\nTest content");

	return prd;
}

beforeEach(() => {
	testDir = createTmpTestDir("test-ralph");
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

describe("findPRDLocation", () => {
	it("finds PRD in pending", async () => {
		await createTestPRD("test-prd", {}, "pending");
		const location = findPRDLocation(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(location, "pending");
	});

	it("finds PRD in qa", async () => {
		await createTestPRD("test-prd", {}, "qa");
		const location = findPRDLocation(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(location, "qa");
	});

	it("returns null for non-existent PRD", () => {
		const location = findPRDLocation(PROJECT_NAME, REPO_ROOT, "non-existent");
		assert.strictEqual(location, null);
	});
});

describe("listPRDsByStatus", () => {
	it("lists all PRDs", async () => {
		await createTestPRD("pending-prd", {}, "pending");
		await createTestPRD("qa-prd", {}, "qa");

		const prds = await listPRDsByStatus(PROJECT_NAME, REPO_ROOT);
		assert.strictEqual(prds.length, 2);
		assert.ok(prds.some((p) => p.name === "pending-prd" && p.status === "pending"));
		assert.ok(prds.some((p) => p.name === "qa-prd" && p.status === "qa"));
	});

	it("filters by status", async () => {
		await createTestPRD("pending-prd", {}, "pending");
		await createTestPRD("qa-prd", {}, "qa");

		const prds = await listPRDsByStatus(PROJECT_NAME, REPO_ROOT, "pending");
		assert.strictEqual(prds.length, 1);
		assert.strictEqual(prds[0]?.name, "pending-prd");
	});
});

describe("listPRDs", () => {
	it("returns empty array when no PRDs exist", async () => {
		const prds = await listPRDs(PROJECT_NAME, REPO_ROOT);
		assert.deepStrictEqual(prds, []);
	});

	it("lists PRDs from all statuses", async () => {
		await createTestPRD("pending-prd", {}, "pending");
		await createTestPRD("qa-prd", {}, "qa");
		await createTestPRD("completed-prd", {}, "completed");

		const prds = await listPRDs(PROJECT_NAME, REPO_ROOT);
		assert.ok(prds.includes("pending-prd"));
		assert.ok(prds.includes("qa-prd"));
		assert.ok(prds.includes("completed-prd"));
	});
});

describe("movePRD", () => {
	it("moves PRD between status folders", async () => {
		await createTestPRD("test-prd", {}, "pending");

		await movePRD(PROJECT_NAME, REPO_ROOT, "test-prd", "qa");

		assert.strictEqual(findPRDLocation(PROJECT_NAME, REPO_ROOT, "test-prd"), "qa");
		const pendingDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"), "test-prd");
		const qaDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "qa"), "test-prd");
		assert.strictEqual(existsSync(pendingDir), false);
		assert.strictEqual(existsSync(qaDir), true);
	});

	it("throws error for non-existent PRD", async () => {
		await assert.rejects(movePRD(PROJECT_NAME, REPO_ROOT, "non-existent", "qa"), /PRD not found/);
	});

	it("no-op when moving to same status", async () => {
		await createTestPRD("test-prd", {}, "pending");
		await movePRD(PROJECT_NAME, REPO_ROOT, "test-prd", "pending");
		assert.strictEqual(findPRDLocation(PROJECT_NAME, REPO_ROOT, "test-prd"), "pending");
	});
});

describe("getPRD", () => {
	it("retrieves PRD from any status folder", async () => {
		await createTestPRD("test-prd", { description: "Test PRD" }, "qa");

		const retrieved = await getPRD(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(retrieved.name, "test-prd");
		assert.strictEqual(retrieved.description, "Test PRD");
	});

	it("throws error for non-existent PRD", async () => {
		await assert.rejects(
			getPRD(PROJECT_NAME, REPO_ROOT, "non-existent"),
			/PRD not found: non-existent/,
		);
	});

	it("throws error for invalid PRD structure", async () => {
		const prdPath = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"), "invalid-prd");
		mkdirSync(prdPath, { recursive: true });
		writeFileSync(join(prdPath, "prd.json"), JSON.stringify({ foo: "bar" }));

		await assert.rejects(getPRD(PROJECT_NAME, REPO_ROOT, "invalid-prd"), /Invalid PRD structure/);
	});
});

describe("updatePRD", () => {
	it("updates PRD fields", async () => {
		await createTestPRD("test-prd", { description: "Original" });

		const updated = await updatePRD(PROJECT_NAME, REPO_ROOT, "test-prd", {
			description: "Updated",
		});

		assert.strictEqual(updated.description, "Updated");

		const retrieved = await getPRD(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(retrieved.description, "Updated");
	});

	it("preserves name even if update tries to change it", async () => {
		await createTestPRD("test-prd");

		const updated = await updatePRD(PROJECT_NAME, REPO_ROOT, "test-prd", {
			name: "different-name" as never,
		});

		assert.strictEqual(updated.name, "test-prd");
	});
});

describe("getNextStory", () => {
	it("returns null when no workable stories", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "completed",
					priority: 1,
					questions: [],
				},
			],
		});

		const story = await getNextStory(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(story, null);
	});

	it("returns highest priority pending story", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "pending",
					priority: 2,
					questions: [],
				},
				{
					id: "US-002",
					title: "Story 2",
					promptPath: "stories/US-002.md",
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		const story = await getNextStory(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(story?.id, "US-002");
	});

	it("skips blocked stories", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "blocked",
					priority: 1,
					questions: ["Question?"],
				},
				{
					id: "US-002",
					title: "Story 2",
					promptPath: "stories/US-002.md",
					status: "pending",
					priority: 2,
					questions: [],
				},
			],
		});

		const story = await getNextStory(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(story?.id, "US-002");
	});
});

describe("updateStoryStatus", () => {
	it("updates story status", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		await updateStoryStatus(PROJECT_NAME, REPO_ROOT, "test-prd", "US-001", "completed");

		const prd = await getPRD(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(prd.stories[0]?.status, "completed");
	});

	it("updates questions when blocking", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		await updateStoryStatus(PROJECT_NAME, REPO_ROOT, "test-prd", "US-001", "blocked", [
			"Question 1?",
			"Question 2?",
		]);

		const prd = await getPRD(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(prd.stories[0]?.status, "blocked");
		assert.deepStrictEqual(prd.stories[0]?.questions, ["Question 1?", "Question 2?"]);
	});

	it("throws error for non-existent story", async () => {
		await createTestPRD("test-prd");

		await assert.rejects(
			updateStoryStatus(PROJECT_NAME, REPO_ROOT, "test-prd", "US-999", "completed"),
			/Story not found/,
		);
	});
});

describe("updateLastRun", () => {
	it("updates lastRun field", async () => {
		await createTestPRD("test-prd");

		await updateLastRun(PROJECT_NAME, REPO_ROOT, "test-prd", {
			timestamp: "2025-01-10T12:00:00Z",
			storyId: "US-001",
			reason: "user_interrupted",
			summary: "Stopped mid-work",
		});

		const prd = await getPRD(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(prd.lastRun?.storyId, "US-001");
		assert.strictEqual(prd.lastRun?.reason, "user_interrupted");
	});
});

describe("isPRDComplete", () => {
	it("returns true when all stories completed", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "completed",
					priority: 1,
					questions: [],
				},
				{
					id: "US-002",
					title: "Story 2",
					promptPath: "stories/US-002.md",
					status: "completed",
					priority: 2,
					questions: [],
				},
			],
		});

		const complete = await isPRDComplete(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(complete, true);
	});

	it("returns false when stories pending", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "completed",
					priority: 1,
					questions: [],
				},
				{
					id: "US-002",
					title: "Story 2",
					promptPath: "stories/US-002.md",
					status: "pending",
					priority: 2,
					questions: [],
				},
			],
		});

		const complete = await isPRDComplete(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(complete, false);
	});
});

describe("hasBlockedStories", () => {
	it("returns blocked stories", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "blocked",
					priority: 1,
					questions: ["Question?"],
				},
				{
					id: "US-002",
					title: "Story 2",
					promptPath: "stories/US-002.md",
					status: "pending",
					priority: 2,
					questions: [],
				},
			],
		});

		const blocked = await hasBlockedStories(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(blocked.length, 1);
		assert.strictEqual(blocked[0]?.id, "US-001");
	});

	it("returns empty array when no blocked stories", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					promptPath: "stories/US-001.md",
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		const blocked = await hasBlockedStories(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.deepStrictEqual(blocked, []);
	});
});

describe("getSpec", () => {
	it("returns spec content", async () => {
		await createTestPRD("test-prd");

		const spec = await getSpec(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.ok(spec.includes("# Test Spec"));
	});

	it("throws error when spec missing", async () => {
		const prdDir = join(getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"), "no-spec");
		mkdirSync(prdDir, { recursive: true });
		await writeFile(
			join(prdDir, "prd.json"),
			JSON.stringify({
				name: "no-spec",
				description: "Test",
				createdAt: new Date().toISOString(),
				stories: [],
			}),
		);

		await assert.rejects(getSpec(PROJECT_NAME, REPO_ROOT, "no-spec"), /Spec file not found/);
	});
});

describe("appendProgress", () => {
	it("appends content to progress log", async () => {
		await createTestPRD("test-prd");

		await appendProgress(PROJECT_NAME, REPO_ROOT, "test-prd", "## Entry 1\n- Item 1");
		await appendProgress(PROJECT_NAME, REPO_ROOT, "test-prd", "## Entry 2\n- Item 2");

		const progress = await getProgress(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.ok(progress.includes("## Entry 1"));
		assert.ok(progress.includes("## Entry 2"));
	});
});

describe("extractFindings", () => {
	it("extracts patterns from progress.txt", async () => {
		await createTestPRD("test-prd");
		const progressPath = join(
			getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"),
			"test-prd",
			"progress.txt",
		);
		await writeFile(
			progressPath,
			`## Codebase Patterns

- Use neverthrow for error handling
- All services return Result types

---

## Progress Log
`,
		);

		const findings = await extractFindings(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.ok(findings.includes("### Patterns"));
		assert.ok(findings.includes("neverthrow"));
	});

	it("extracts learnings from progress.txt", async () => {
		await createTestPRD("test-prd");
		const progressPath = join(
			getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"),
			"test-prd",
			"progress.txt",
		);
		await writeFile(
			progressPath,
			`## Codebase Patterns

---

## Progress Log

## [2026-01-26] - US-001
- Implemented auth
**Learnings for future iterations:**
- Always check for existing session
- Use httpOnly cookies
---
`,
		);

		const findings = await extractFindings(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.ok(findings.includes("### Learnings"));
		assert.ok(findings.includes("httpOnly cookies"));
	});

	it("returns empty string when no patterns or learnings", async () => {
		await createTestPRD("test-prd");
		const progressPath = join(
			getStatusDir(PROJECT_NAME, REPO_ROOT, "pending"),
			"test-prd",
			"progress.txt",
		);
		await writeFile(progressPath, "## Progress Log\n\nNothing here\n");

		const findings = await extractFindings(PROJECT_NAME, REPO_ROOT, "test-prd");
		assert.strictEqual(findings, "");
	});
});
