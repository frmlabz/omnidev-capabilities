/**
 * Tests for Ralph state management
 */

import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	appendProgress,
	ensureDirectories,
	extractFindings,
	findPRDLocation,
	getNextStory,
	getPRD,
	getProgress,
	getSpec,
	hasBlockedStories,
	isPRDComplete,
	listPRDs,
	listPRDsByStatus,
	migrateToStatusFolders,
	movePRD,
	needsMigration,
	updateLastRun,
	updatePRD,
	updateStoryStatus,
} from "./state.ts";
import type { PRD, PRDStatus } from "./types.ts";

let testDir: string;
let originalCwd: string;

async function createTestPRD(
	name: string,
	options: Partial<PRD> = {},
	status: PRDStatus = "pending",
): Promise<PRD> {
	const prdDir = `.omni/state/ralph/prds/${status}/${name}`;
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
	testDir = join(
		process.cwd(),
		".test-ralph",
		`test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
	);
	mkdirSync(testDir, { recursive: true });
	originalCwd = process.cwd();
	process.chdir(testDir);
	ensureDirectories();
});

afterEach(() => {
	process.chdir(originalCwd);
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

describe("findPRDLocation", () => {
	it("finds PRD in pending", async () => {
		await createTestPRD("test-prd", {}, "pending");
		const location = findPRDLocation("test-prd");
		assert.strictEqual(location, "pending");
	});

	it("finds PRD in testing", async () => {
		await createTestPRD("test-prd", {}, "testing");
		const location = findPRDLocation("test-prd");
		assert.strictEqual(location, "testing");
	});

	it("returns null for non-existent PRD", () => {
		const location = findPRDLocation("non-existent");
		assert.strictEqual(location, null);
	});
});

describe("listPRDsByStatus", () => {
	it("lists all PRDs", async () => {
		await createTestPRD("pending-prd", {}, "pending");
		await createTestPRD("testing-prd", {}, "testing");

		const prds = await listPRDsByStatus();
		assert.strictEqual(prds.length, 2);
		assert.ok(prds.some((p) => p.name === "pending-prd" && p.status === "pending"));
		assert.ok(prds.some((p) => p.name === "testing-prd" && p.status === "testing"));
	});

	it("filters by status", async () => {
		await createTestPRD("pending-prd", {}, "pending");
		await createTestPRD("testing-prd", {}, "testing");

		const prds = await listPRDsByStatus("pending");
		assert.strictEqual(prds.length, 1);
		assert.strictEqual(prds[0]?.name, "pending-prd");
	});
});

describe("listPRDs", () => {
	it("returns empty array when no PRDs exist", async () => {
		const prds = await listPRDs();
		assert.deepStrictEqual(prds, []);
	});

	it("lists PRDs from all statuses", async () => {
		await createTestPRD("pending-prd", {}, "pending");
		await createTestPRD("testing-prd", {}, "testing");
		await createTestPRD("completed-prd", {}, "completed");

		const prds = await listPRDs();
		assert.ok(prds.includes("pending-prd"));
		assert.ok(prds.includes("testing-prd"));
		assert.ok(prds.includes("completed-prd"));
	});
});

describe("movePRD", () => {
	it("moves PRD between status folders", async () => {
		await createTestPRD("test-prd", {}, "pending");

		await movePRD("test-prd", "testing");

		assert.strictEqual(findPRDLocation("test-prd"), "testing");
		assert.strictEqual(existsSync(".omni/state/ralph/prds/pending/test-prd"), false);
		assert.strictEqual(existsSync(".omni/state/ralph/prds/testing/test-prd"), true);
	});

	it("throws error for non-existent PRD", async () => {
		await assert.rejects(movePRD("non-existent", "testing"), /PRD not found/);
	});

	it("no-op when moving to same status", async () => {
		await createTestPRD("test-prd", {}, "pending");
		await movePRD("test-prd", "pending");
		assert.strictEqual(findPRDLocation("test-prd"), "pending");
	});
});

describe("getPRD", () => {
	it("retrieves PRD from any status folder", async () => {
		await createTestPRD("test-prd", { description: "Test PRD" }, "testing");

		const retrieved = await getPRD("test-prd");
		assert.strictEqual(retrieved.name, "test-prd");
		assert.strictEqual(retrieved.description, "Test PRD");
	});

	it("throws error for non-existent PRD", async () => {
		await assert.rejects(getPRD("non-existent"), /PRD not found: non-existent/);
	});

	it("throws error for invalid PRD structure", async () => {
		const prdPath = ".omni/state/ralph/prds/pending/invalid-prd";
		mkdirSync(prdPath, { recursive: true });
		writeFileSync(join(prdPath, "prd.json"), JSON.stringify({ foo: "bar" }));

		await assert.rejects(getPRD("invalid-prd"), /Invalid PRD structure/);
	});
});

describe("updatePRD", () => {
	it("updates PRD fields", async () => {
		await createTestPRD("test-prd", { description: "Original" });

		const updated = await updatePRD("test-prd", { description: "Updated" });

		assert.strictEqual(updated.description, "Updated");

		const retrieved = await getPRD("test-prd");
		assert.strictEqual(retrieved.description, "Updated");
	});

	it("preserves name even if update tries to change it", async () => {
		await createTestPRD("test-prd");

		const updated = await updatePRD("test-prd", {
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
					acceptanceCriteria: [],
					status: "completed",
					priority: 1,
					questions: [],
				},
			],
		});

		const story = await getNextStory("test-prd");
		assert.strictEqual(story, null);
	});

	it("returns highest priority pending story", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					acceptanceCriteria: [],
					status: "pending",
					priority: 2,
					questions: [],
				},
				{
					id: "US-002",
					title: "Story 2",
					acceptanceCriteria: [],
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		const story = await getNextStory("test-prd");
		assert.strictEqual(story?.id, "US-002");
	});

	it("skips blocked stories", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					acceptanceCriteria: [],
					status: "blocked",
					priority: 1,
					questions: ["Question?"],
				},
				{
					id: "US-002",
					title: "Story 2",
					acceptanceCriteria: [],
					status: "pending",
					priority: 2,
					questions: [],
				},
			],
		});

		const story = await getNextStory("test-prd");
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
					acceptanceCriteria: [],
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		await updateStoryStatus("test-prd", "US-001", "completed");

		const prd = await getPRD("test-prd");
		assert.strictEqual(prd.stories[0]?.status, "completed");
	});

	it("updates questions when blocking", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					acceptanceCriteria: [],
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		await updateStoryStatus("test-prd", "US-001", "blocked", ["Question 1?", "Question 2?"]);

		const prd = await getPRD("test-prd");
		assert.strictEqual(prd.stories[0]?.status, "blocked");
		assert.deepStrictEqual(prd.stories[0]?.questions, ["Question 1?", "Question 2?"]);
	});

	it("throws error for non-existent story", async () => {
		await createTestPRD("test-prd");

		await assert.rejects(updateStoryStatus("test-prd", "US-999", "completed"), /Story not found/);
	});
});

describe("updateLastRun", () => {
	it("updates lastRun field", async () => {
		await createTestPRD("test-prd");

		await updateLastRun("test-prd", {
			timestamp: "2025-01-10T12:00:00Z",
			storyId: "US-001",
			reason: "user_interrupted",
			summary: "Stopped mid-work",
		});

		const prd = await getPRD("test-prd");
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
					acceptanceCriteria: [],
					status: "completed",
					priority: 1,
					questions: [],
				},
				{
					id: "US-002",
					title: "Story 2",
					acceptanceCriteria: [],
					status: "completed",
					priority: 2,
					questions: [],
				},
			],
		});

		const complete = await isPRDComplete("test-prd");
		assert.strictEqual(complete, true);
	});

	it("returns false when stories pending", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					acceptanceCriteria: [],
					status: "completed",
					priority: 1,
					questions: [],
				},
				{
					id: "US-002",
					title: "Story 2",
					acceptanceCriteria: [],
					status: "pending",
					priority: 2,
					questions: [],
				},
			],
		});

		const complete = await isPRDComplete("test-prd");
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
					acceptanceCriteria: [],
					status: "blocked",
					priority: 1,
					questions: ["Question?"],
				},
				{
					id: "US-002",
					title: "Story 2",
					acceptanceCriteria: [],
					status: "pending",
					priority: 2,
					questions: [],
				},
			],
		});

		const blocked = await hasBlockedStories("test-prd");
		assert.strictEqual(blocked.length, 1);
		assert.strictEqual(blocked[0]?.id, "US-001");
	});

	it("returns empty array when no blocked stories", async () => {
		await createTestPRD("test-prd", {
			stories: [
				{
					id: "US-001",
					title: "Story 1",
					acceptanceCriteria: [],
					status: "pending",
					priority: 1,
					questions: [],
				},
			],
		});

		const blocked = await hasBlockedStories("test-prd");
		assert.deepStrictEqual(blocked, []);
	});
});

describe("getSpec", () => {
	it("returns spec content", async () => {
		await createTestPRD("test-prd");

		const spec = await getSpec("test-prd");
		assert.ok(spec.includes("# Test Spec"));
	});

	it("throws error when spec missing", async () => {
		const prdDir = ".omni/state/ralph/prds/pending/no-spec";
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

		await assert.rejects(getSpec("no-spec"), /Spec file not found/);
	});
});

describe("appendProgress", () => {
	it("appends content to progress log", async () => {
		await createTestPRD("test-prd");

		await appendProgress("test-prd", "## Entry 1\n- Item 1");
		await appendProgress("test-prd", "## Entry 2\n- Item 2");

		const progress = await getProgress("test-prd");
		assert.ok(progress.includes("## Entry 1"));
		assert.ok(progress.includes("## Entry 2"));
	});
});

describe("extractFindings", () => {
	it("extracts patterns from progress.txt", async () => {
		await createTestPRD("test-prd");
		const progressPath = ".omni/state/ralph/prds/pending/test-prd/progress.txt";
		await writeFile(
			progressPath,
			`## Codebase Patterns

- Use neverthrow for error handling
- All services return Result types

---

## Progress Log
`,
		);

		const findings = await extractFindings("test-prd");
		assert.ok(findings.includes("### Patterns"));
		assert.ok(findings.includes("neverthrow"));
	});

	it("extracts learnings from progress.txt", async () => {
		await createTestPRD("test-prd");
		const progressPath = ".omni/state/ralph/prds/pending/test-prd/progress.txt";
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

		const findings = await extractFindings("test-prd");
		assert.ok(findings.includes("### Learnings"));
		assert.ok(findings.includes("httpOnly cookies"));
	});

	it("returns empty string when no patterns or learnings", async () => {
		await createTestPRD("test-prd");
		const progressPath = ".omni/state/ralph/prds/pending/test-prd/progress.txt";
		await writeFile(progressPath, "## Progress Log\n\nNothing here\n");

		const findings = await extractFindings("test-prd");
		assert.strictEqual(findings, "");
	});
});

describe("migration", () => {
	it("needsMigration returns true for old structure", async () => {
		// Create old structure (PRDs directly in prds/)
		const oldPrdDir = ".omni/state/ralph/prds/old-prd";
		mkdirSync(oldPrdDir, { recursive: true });
		writeFileSync(
			join(oldPrdDir, "prd.json"),
			JSON.stringify({
				name: "old-prd",
				description: "Test",
				createdAt: new Date().toISOString(),
				stories: [],
			}),
		);

		assert.strictEqual(needsMigration(), true);
	});

	it("needsMigration returns false for new structure", async () => {
		await createTestPRD("test-prd", {}, "pending");
		assert.strictEqual(needsMigration(), false);
	});

	it("migrateToStatusFolders moves PRDs to pending", async () => {
		// Create old structure
		const oldPrdDir = ".omni/state/ralph/prds/migrate-test";
		mkdirSync(oldPrdDir, { recursive: true });
		writeFileSync(
			join(oldPrdDir, "prd.json"),
			JSON.stringify({
				name: "migrate-test",
				description: "Test",
				createdAt: new Date().toISOString(),
				stories: [],
			}),
		);

		const { migrated, errors } = await migrateToStatusFolders();

		assert.strictEqual(migrated, 1);
		assert.strictEqual(errors.length, 0);
		assert.strictEqual(findPRDLocation("migrate-test"), "pending");
	});

	it("migrateToStatusFolders handles completed-prds", async () => {
		// Create old completed-prds structure
		const oldCompletedDir = ".omni/state/ralph/completed-prds/2026-01-20-old-completed";
		mkdirSync(oldCompletedDir, { recursive: true });
		writeFileSync(
			join(oldCompletedDir, "prd.json"),
			JSON.stringify({
				name: "old-completed",
				description: "Test",
				createdAt: new Date().toISOString(),
				stories: [],
			}),
		);

		const { migrated, errors } = await migrateToStatusFolders();

		assert.strictEqual(migrated, 1);
		assert.strictEqual(errors.length, 0);
		assert.strictEqual(findPRDLocation("old-completed"), "completed");
	});
});
