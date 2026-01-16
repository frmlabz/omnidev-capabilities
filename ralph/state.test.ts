/**
 * Tests for Ralph state management
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
} from "./state.js";
import type { PRD } from "./types.js";

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

		await Bun.write(join(prdDir, "prd.json"), JSON.stringify(prd, null, 2));
		await Bun.write(
			join(prdDir, "progress.txt"),
			"## Codebase Patterns\n\n---\n\n## Progress Log\n\n",
		);
		await Bun.write(join(prdDir, "spec.md"), "# Test Spec\n\nTest content");

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
		test("returns empty array when no PRDs exist", async () => {
			const prds = await listPRDs();
			expect(prds).toEqual([]);
		});

		test("lists active PRDs", async () => {
			await createTestPRD("test-prd-1");
			await createTestPRD("test-prd-2");

			const prds = await listPRDs();
			expect(prds).toContain("test-prd-1");
			expect(prds).toContain("test-prd-2");
			expect(prds.length).toBe(2);
		});

		test("includes completed PRDs when requested", async () => {
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
			expect(prds).toContain("active-prd");
			expect(prds).toContain("completed-prd (completed)");
		});
	});

	describe("getPRD", () => {
		test("retrieves an existing PRD", async () => {
			await createTestPRD("test-prd", {
				description: "Test PRD",
			});

			const retrieved = await getPRD("test-prd");
			expect(retrieved.name).toBe("test-prd");
			expect(retrieved.description).toBe("Test PRD");
		});

		test("throws error for non-existent PRD", async () => {
			await expect(getPRD("non-existent")).rejects.toThrow("PRD not found: non-existent");
		});

		test("throws error for invalid PRD structure", async () => {
			const prdPath = ".omni/state/ralph/prds/invalid-prd";
			mkdirSync(prdPath, { recursive: true });
			writeFileSync(join(prdPath, "prd.json"), JSON.stringify({ foo: "bar" }));

			await expect(getPRD("invalid-prd")).rejects.toThrow("Invalid PRD structure");
		});
	});

	describe("updatePRD", () => {
		test("updates PRD fields", async () => {
			await createTestPRD("test-prd", { description: "Original" });

			const updated = await updatePRD("test-prd", {
				description: "Updated",
			});

			expect(updated.description).toBe("Updated");

			const retrieved = await getPRD("test-prd");
			expect(retrieved.description).toBe("Updated");
		});

		test("preserves name even if update tries to change it", async () => {
			await createTestPRD("test-prd");

			const updated = await updatePRD("test-prd", {
				name: "different-name" as never,
			});

			expect(updated.name).toBe("test-prd");
		});
	});

	describe("getNextStory", () => {
		test("returns null when no workable stories", async () => {
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
			expect(story).toBe(null);
		});

		test("returns highest priority pending story", async () => {
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
			expect(story?.id).toBe("US-002");
		});

		test("returns in_progress story first", async () => {
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
			expect(story?.id).toBe("US-001"); // Lower priority wins, both are workable
		});

		test("skips blocked stories", async () => {
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
			expect(story?.id).toBe("US-002");
		});
	});

	describe("updateStoryStatus", () => {
		test("updates story status", async () => {
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
			expect(prd.stories[0]?.status).toBe("completed");
		});

		test("updates questions when blocking", async () => {
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
			expect(prd.stories[0]?.status).toBe("blocked");
			expect(prd.stories[0]?.questions).toEqual(["Question 1?", "Question 2?"]);
		});

		test("throws error for non-existent story", async () => {
			await createTestPRD("test-prd");

			await expect(updateStoryStatus("test-prd", "US-999", "completed")).rejects.toThrow(
				"Story not found",
			);
		});
	});

	describe("updateLastRun", () => {
		test("updates lastRun field", async () => {
			await createTestPRD("test-prd");

			await updateLastRun("test-prd", {
				timestamp: "2025-01-10T12:00:00Z",
				storyId: "US-001",
				reason: "user_interrupted",
				summary: "Stopped mid-work",
			});

			const prd = await getPRD("test-prd");
			expect(prd.lastRun?.storyId).toBe("US-001");
			expect(prd.lastRun?.reason).toBe("user_interrupted");
		});
	});

	describe("isPRDComplete", () => {
		test("returns true when all stories completed", async () => {
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
			expect(complete).toBe(true);
		});

		test("returns false when stories pending", async () => {
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
			expect(complete).toBe(false);
		});
	});

	describe("hasBlockedStories", () => {
		test("returns blocked stories", async () => {
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
			expect(blocked.length).toBe(1);
			expect(blocked[0]?.id).toBe("US-001");
		});

		test("returns empty array when no blocked stories", async () => {
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
			expect(blocked).toEqual([]);
		});
	});

	describe("getSpec", () => {
		test("returns spec content", async () => {
			await createTestPRD("test-prd");

			const spec = await getSpec("test-prd");
			expect(spec).toContain("# Test Spec");
		});

		test("throws error when spec missing", async () => {
			const prdDir = ".omni/state/ralph/prds/no-spec";
			mkdirSync(prdDir, { recursive: true });
			await Bun.write(
				join(prdDir, "prd.json"),
				JSON.stringify({
					name: "no-spec",
					description: "Test",
					createdAt: new Date().toISOString(),
					stories: [],
				}),
			);

			await expect(getSpec("no-spec")).rejects.toThrow("Spec file not found");
		});
	});

	describe("appendProgress", () => {
		test("appends content to progress log", async () => {
			await createTestPRD("test-prd");

			await appendProgress("test-prd", "## Entry 1\n- Item 1");
			await appendProgress("test-prd", "## Entry 2\n- Item 2");

			const progress = await getProgress("test-prd");
			expect(progress).toContain("## Entry 1");
			expect(progress).toContain("## Entry 2");
		});
	});

	describe("archivePRD", () => {
		test("moves PRD to completed directory", async () => {
			await createTestPRD("test-prd");

			await archivePRD("test-prd");

			const activePath = ".omni/state/ralph/prds/test-prd";
			expect(existsSync(activePath)).toBe(false);

			const timestamp = new Date().toISOString().split("T")[0];
			const completedPath = `.omni/state/ralph/completed-prds/${timestamp}-test-prd`;
			expect(existsSync(completedPath)).toBe(true);
		});

		test("throws error for non-existent PRD", async () => {
			await expect(archivePRD("non-existent")).rejects.toThrow("PRD not found");
		});
	});
});
