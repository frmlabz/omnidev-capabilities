import { afterEach, beforeEach, it } from "bun:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getDefaultStore,
	getReviewConfig,
	getStateDir,
	getStatusDir,
	ReviewEngine,
	resolveReviewProviderVariants,
} from "./lib/index.js";
import type { PRD, RalphConfig } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

const PROJECT_NAME = "review-test";

function prepareReviewableFeatureBranch(repoRoot: string): void {
	writeFileSync(join(repoRoot, "tracked.txt"), "base\n");
	execSync("git add tracked.txt", { cwd: repoRoot });
	execSync('git commit -m "base tracked file" -q', { cwd: repoRoot });
	execSync("git branch -M main", { cwd: repoRoot });
	execSync("git checkout -q -b feature/review-aggregate", { cwd: repoRoot });
	writeFileSync(join(repoRoot, "tracked.txt"), "feature change\n");
	execSync("git add tracked.txt", { cwd: repoRoot });
	execSync('git commit -m "feature change" -q', { cwd: repoRoot });
}

async function createReviewablePrd(repoRoot: string, prdName: string): Promise<PRD> {
	const prdDir = join(getStatusDir(PROJECT_NAME, repoRoot, "in_progress"), prdName);
	mkdirSync(prdDir, { recursive: true });
	mkdirSync(join(prdDir, "stories"), { recursive: true });

	const prd: PRD = {
		name: prdName,
		description: "Review aggregation test",
		createdAt: new Date().toISOString(),
		stories: [
			{
				id: "US-001",
				title: "Implement feature",
				promptPath: "stories/US-001.md",
				status: "completed",
				priority: 1,
				questions: [],
			},
		],
	};

	await writeFile(join(prdDir, "prd.json"), JSON.stringify(prd, null, 2));
	await writeFile(join(prdDir, "progress.txt"), "## Progress Log\n\n");
	await writeFile(join(prdDir, "spec.md"), "# Spec\n\nTest spec");
	await writeFile(
		join(prdDir, "stories", "US-001.md"),
		"# US-001: Implement feature\n\n## Acceptance Criteria\n- [ ] Feature works\n",
	);

	return prd;
}

let testDir = "";
let originalCwd = "";
let originalXdg: string | undefined;

beforeEach(() => {
	testDir = createTmpTestDir("ralph-review-engine");
	originalCwd = process.cwd();
	process.chdir(testDir);
	execSync("git init -q", { cwd: testDir });
	execSync("git commit --allow-empty -m init -q", { cwd: testDir });
	prepareReviewableFeatureBranch(testDir);
	originalXdg = process.env["XDG_STATE_HOME"];
	process.env["XDG_STATE_HOME"] = testDir;
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

it("aggregates first-pass reviewers, dedupes blockers, and writes non-blocking findings to todo_file", async () => {
	const prd = await createReviewablePrd(testDir, "demo-prd");
	const prompts: string[] = [];
	const counts = new Map<string, number>();

	const mockAgentExecutor = {
		async run(prompt: string) {
			prompts.push(prompt);

			if (prompt.includes("<Findings_To_Fix>")) {
				return { output: "<promise>COMPLETE</promise>", exitCode: 0, aborted: false };
			}

			if (prompt.startsWith("# Code Review Request:")) {
				const current = (counts.get("external") ?? 0) + 1;
				counts.set("external", current);
				if (current === 1) {
					return {
						output: `<review-result>REQUEST_CHANGES</review-result>
<review-findings>
- [MAJOR] tracked.txt:1 - Shared blocker
- [SUGGESTION] docs.md:2 - Optional doc polish
</review-findings>`,
						exitCode: 0,
						aborted: false,
					};
				}
				return {
					output: `<review-result>APPROVE</review-result>
<review-findings>
- [SUGGESTION] docs.md:2 - Optional doc polish
</review-findings>`,
					exitCode: 0,
					aborted: false,
				};
			}

			if (prompt.startsWith("# Code Review: demo-prd (quality)")) {
				const phase = prompt.includes("second review pass") ? "quality-second" : "quality-first";
				const current = (counts.get(phase) ?? 0) + 1;
				counts.set(phase, current);
				if (phase === "quality-first" && current === 1) {
					return {
						output: `<review-result>REQUEST_CHANGES</review-result>
<review-findings>
- [MAJOR] tracked.txt:1 - Shared blocker
- [MINOR] src/quality.ts:9 - Add a regression test
</review-findings>`,
						exitCode: 0,
						aborted: false,
					};
				}
				if (phase === "quality-first") {
					return {
						output: `<review-result>APPROVE</review-result>
<review-findings>
- [MINOR] src/quality.ts:9 - Add a regression test
</review-findings>`,
						exitCode: 0,
						aborted: false,
					};
				}
				return { output: "<review-result>APPROVE</review-result>", exitCode: 0, aborted: false };
			}

			if (prompt.startsWith("# Code Review: demo-prd (implementation)")) {
				const current = (counts.get("implementation") ?? 0) + 1;
				counts.set("implementation", current);
				if (current === 1) {
					return {
						output: `<review-result>REQUEST_CHANGES</review-result>
<review-findings>
- [MAJOR] tracked.txt:1 - Shared blocker
</review-findings>`,
						exitCode: 0,
						aborted: false,
					};
				}
				return { output: "<review-result>APPROVE</review-result>", exitCode: 0, aborted: false };
			}

			return { output: "<review-result>APPROVE</review-result>", exitCode: 0, aborted: false };
		},
		parseTokenUsage() {
			return {};
		},
		hasCompletionSignal(output: string) {
			return output.includes("<promise>COMPLETE</promise>");
		},
		parseStatus() {
			return null;
		},
	};

	const config: RalphConfig = {
		project_name: PROJECT_NAME,
		default_provider_variant: "test",
		default_iterations: 5,
		provider_variants: {
			test: { command: "echo", args: ["test"] },
			codex: { command: "echo", args: ["codex"] },
		},
		review: {
			review_provider_variant: "codex",
			first_review_agents: ["quality", "implementation"],
			second_review_agents: ["quality"],
			max_fix_iterations: 2,
			todo_file: ".ralph-review-todo.md",
		},
	};

	const reviewConfig = getReviewConfig(config);
	const variantsResult = resolveReviewProviderVariants(config, reviewConfig);
	assert.ok(variantsResult.ok);

	const engine = new ReviewEngine({
		projectName: PROJECT_NAME,
		repoRoot: testDir,
		store: getDefaultStore(PROJECT_NAME, testDir),
		agentExecutor: mockAgentExecutor as never,
		logger: { log() {} } as never,
	});

	const result = await engine.runReview(
		prd.name,
		prd,
		config,
		variantsResult.data!,
		reviewConfig,
		() => {},
	);

	assert.ok(result.ok);

	const fixPrompt = prompts.find((prompt) => prompt.includes("<Findings_To_Fix>"));
	assert.ok(fixPrompt);
	assert.strictEqual(fixPrompt!.match(/- \[MAJOR\]/g)?.length ?? 0, 1);

	const todoPath = join(testDir, ".ralph-review-todo.md");
	assert.ok(existsSync(todoPath));
	const todoContent = readFileSync(todoPath, "utf-8");
	assert.ok(todoContent.includes("## demo-prd"));
	assert.ok(todoContent.includes("### Follow-Ups"));
	assert.ok(todoContent.includes("Add a regression test"));
	assert.ok(todoContent.includes("### Noise / Suggestions"));
	assert.ok(todoContent.includes("Optional doc polish"));

	const firstReviewPath = join(
		getStateDir(PROJECT_NAME, testDir),
		"prds",
		"in_progress",
		"demo-prd",
		"review-results",
		"first-review.md",
	);
	assert.ok(existsSync(firstReviewPath));
	const firstReviewContent = readFileSync(firstReviewPath, "utf-8");
	assert.ok(firstReviewContent.includes("## external-codex"));
});
