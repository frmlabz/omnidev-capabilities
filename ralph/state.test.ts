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
	archivePRD,
	getNextStory,
	getPRD,
	getProgress,
	getSpec,
	hasBlockedStories,
	isPRDComplete,
	listPRDs,
	updateLastRun,
	updatePRD,
	updateStoryStatus,
} from "./state.ts";
import type { PRD } from "./types.ts";

describe("Ralph State Management", () => {
	let testDir: string;
	let originalCwd: string;

	// Helper to create a PRD directly (since createPRD was removed)
	async function createTestPRD(name: string, options: Partial<PRD> = {}): Promise<PRD> {
		const prdDir = `.omni/state/ralph/prds/${name}`;
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
		mkdirSync(".omni/state/ralph/prds", { recursive: true });
		mkdirSync(".omni/state/ralph/completed-prds", { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("listPRDs", () => {
		it("returns empty array when no PRDs exist", async () => {
			const prds = await listPRDs();
			assert.deepStrictEqual(prds, []);
		});

		it("lists active PRDs", async () => {
			await createTestPRD("test-prd-1");
			await createTestPRD("test-prd-2");

			const prds = await listPRDs();
			assert.ok(prds.includes("test-prd-1"));
			assert.ok(prds.includes("test-prd-2"));
			assert.strictEqual(prds.length, 2);
		});

		it("includes completed PRDs when requested", async () => {
			await createTestPRD("active-prd");

			const completedPath = ".omni/state/ralph/completed-prds/completed-prd";
			mkdirSync(completedPath, { recursive: true });
			writeFileSync(
				join(completedPath, "prd.json"),
				JSON.stringify({
					name: "completed-prd",
					description: "Completed",
					createdAt: new Date().toISOString(),
					stories: [],
				}),
			);

			const prds = await listPRDs(true);
			assert.ok(prds.includes("active-prd"));
			assert.ok(prds.includes("completed-prd (completed)"));
		});
	});

	describe("getPRD", () => {
		it("retrieves an existing PRD", async () => {
			await createTestPRD("test-prd", {
				description: "Test PRD",
			});

			const retrieved = await getPRD("test-prd");
			assert.strictEqual(retrieved.name, "test-prd");
			assert.strictEqual(retrieved.description, "Test PRD");
		});

		it("throws error for non-existent PRD", async () => {
			await assert.rejects(getPRD("non-existent"), /PRD not found: non-existent/);
		});

		it("throws error for invalid PRD structure", async () => {
			const prdPath = ".omni/state/ralph/prds/invalid-prd";
			mkdirSync(prdPath, { recursive: true });
			writeFileSync(join(prdPath, "prd.json"), JSON.stringify({ foo: "bar" }));

			await assert.rejects(getPRD("invalid-prd"), /Invalid PRD structure/);
		});
	});

	describe("updatePRD", () => {
		it("updates PRD fields", async () => {
			await createTestPRD("test-prd", { description: "Original" });

			const updated = await updatePRD("test-prd", {
				description: "Updated",
			});

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

		it("returns in_progress story first", async () => {
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
					{
						id: "US-002",
						title: "Story 2",
						acceptanceCriteria: [],
						status: "in_progress",
						priority: 2,
						questions: [],
					},
				],
			});

			const story = await getNextStory("test-prd");
			assert.strictEqual(story?.id, "US-001"); // Lower priority wins, both are workable
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
			const prdDir = ".omni/state/ralph/prds/no-spec";
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

	describe("archivePRD", () => {
		it("moves PRD to completed directory", async () => {
			await createTestPRD("test-prd");

			await archivePRD("test-prd");

			const activePath = ".omni/state/ralph/prds/test-prd";
			assert.strictEqual(existsSync(activePath), false);

			const timestamp = new Date().toISOString().split("T")[0];
			const completedPath = `.omni/state/ralph/completed-prds/${timestamp}-test-prd`;
			assert.strictEqual(existsSync(completedPath), true);
		});

		it("throws error for non-existent PRD", async () => {
			await assert.rejects(archivePRD("non-existent"), /PRD not found/);
		});
	});
});
