import assert from "node:assert";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import type { AgentResult, RunOptions } from "./lib/orchestration/agent-runner.js";
import {
	MAX_DIFF_CHARS,
	captureCurrentCommit,
	failedAcsToQuestions,
	getStoryDiff,
	parseVerifierOutput,
	verifyStory,
} from "./lib/orchestration/story-verifier.js";
import type { AgentConfig, Story } from "./lib/types.js";
import { cleanupTmpTestDir, createTmpTestDir } from "./test-helpers.js";

function makeStory(overrides: Partial<Story> = {}): Story {
	return {
		id: "US-001",
		title: "Add feature X",
		acceptanceCriteria: ["Handler exists", "Test added", "Logs emitted"],
		status: "in_progress",
		priority: 1,
		questions: [],
		...overrides,
	};
}

class FakeExecutor {
	calls: Array<{ prompt: string; config: AgentConfig; options?: RunOptions }> = [];
	private readonly output: string;
	constructor(output: string) {
		this.output = output;
	}
	async run(prompt: string, config: AgentConfig, options?: RunOptions): Promise<AgentResult> {
		this.calls.push({ prompt, config, options });
		return { output: this.output, exitCode: 0, aborted: false };
	}
}

const AGENT_CONFIG: AgentConfig = { command: "echo", args: [] };

it("parseVerifierOutput: all met + PASS produces pass=true", () => {
	const out = `
<ac id="1" status="met" evidence="src/a.ts:1"/>
<ac id="2" status="met" evidence="src/a.ts:2"/>
<verification-result>PASS</verification-result>
`;
	const r = parseVerifierOutput(out);
	assert.equal(r.pass, true);
	assert.deepEqual(r.failedAcs, []);
});

it("parseVerifierOutput: unmet AC forces pass=false even if result says PASS", () => {
	const out = `
<ac id="1" status="met" evidence="ok"/>
<ac id="2" status="unmet" evidence="no logging found"/>
<verification-result>PASS</verification-result>
`;
	const r = parseVerifierOutput(out);
	assert.equal(r.pass, false);
	assert.equal(r.failedAcs.length, 1);
	const first = r.failedAcs[0];
	assert.ok(first);
	assert.equal(first.id, "2");
	assert.equal(first.status, "unmet");
	assert.equal(first.evidence, "no logging found");
});

it("parseVerifierOutput: partial AC is treated as a failure", () => {
	const out = `
<ac id="1" status="partial" evidence="handler stub only"/>
<verification-result>FAIL</verification-result>
`;
	const r = parseVerifierOutput(out);
	assert.equal(r.pass, false);
	assert.equal(r.failedAcs.length, 1);
	assert.equal(r.failedAcs[0]?.status, "partial");
});

it("parseVerifierOutput: missing <verification-result> biases toward FAIL", () => {
	const out = `<ac id="1" status="met" evidence="ok"/>`;
	const r = parseVerifierOutput(out);
	assert.equal(r.pass, false);
	assert.deepEqual(r.failedAcs, []);
});

it("parseVerifierOutput: declared FAIL with all met still marks pass=false", () => {
	const out = `
<ac id="1" status="met" evidence="ok"/>
<verification-result>FAIL</verification-result>
`;
	const r = parseVerifierOutput(out);
	assert.equal(r.pass, false);
});

it("getStoryDiff: returns empty string when startCommit is undefined", () => {
	const d = getStoryDiff("/nonexistent", undefined);
	assert.equal(d, "");
});

let repoDir = "";

function initRepo(): string {
	const dir = createTmpTestDir("ralph-verifier-diff");
	execSync("git init -q", { cwd: dir });
	execSync("git config user.email test@test.local", { cwd: dir });
	execSync("git config user.name test", { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "base\n");
	execSync("git add a.txt", { cwd: dir });
	execSync("git commit -q -m base", { cwd: dir });
	return dir;
}

beforeEach(() => {
	repoDir = "";
});

afterEach(() => {
	if (repoDir) cleanupTmpTestDir(repoDir);
});

it("getStoryDiff: captures changes since startCommit", () => {
	repoDir = initRepo();
	const start = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
	writeFileSync(join(repoDir, "a.txt"), "changed\n");
	execSync("git add a.txt", { cwd: repoDir });
	execSync("git commit -q -m change", { cwd: repoDir });
	const diff = getStoryDiff(repoDir, start);
	assert.ok(diff.includes("-base"));
	assert.ok(diff.includes("+changed"));
});

it("getStoryDiff: truncates at MAX_DIFF_CHARS", () => {
	repoDir = initRepo();
	const start = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
	const big = "x".repeat(MAX_DIFF_CHARS * 2);
	writeFileSync(join(repoDir, "big.txt"), big);
	execSync("git add big.txt", { cwd: repoDir });
	execSync("git commit -q -m big", { cwd: repoDir });
	const diff = getStoryDiff(repoDir, start);
	assert.ok(diff.length <= MAX_DIFF_CHARS + 100);
	assert.ok(diff.includes("(truncated at"));
});

it("captureCurrentCommit: returns a sha in a real repo and undefined elsewhere", () => {
	repoDir = initRepo();
	const sha = captureCurrentCommit(repoDir);
	assert.ok(sha && /^[0-9a-f]{40}$/.test(sha));
	const missing = captureCurrentCommit("/nonexistent-path-xyz");
	assert.equal(missing, undefined);
});

it("verifyStory: returns skipped=true when story has no startCommit", async () => {
	const story = makeStory();
	const executor = new FakeExecutor("should not be called");
	const outcome = await verifyStory({
		story,
		repoRoot: "/tmp",
		agentConfig: AGENT_CONFIG,
		// biome-ignore lint/suspicious/noExplicitAny: test double
		agentExecutor: executor as any,
	});
	assert.equal(outcome.skipped, true);
	assert.equal(outcome.pass, true);
	assert.equal(executor.calls.length, 0);
});

it("verifyStory: marks all ACs unmet when diff is empty", async () => {
	repoDir = initRepo();
	const start = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
	const story = makeStory({ startCommit: start });
	const executor = new FakeExecutor("unused");
	const outcome = await verifyStory({
		story,
		repoRoot: repoDir,
		agentConfig: AGENT_CONFIG,
		// biome-ignore lint/suspicious/noExplicitAny: test double
		agentExecutor: executor as any,
	});
	assert.equal(outcome.pass, false);
	assert.equal(executor.calls.length, 0);
	assert.equal(outcome.failedAcs.length, story.acceptanceCriteria.length);
	assert.ok(outcome.failedAcs.every((fa) => fa.status === "unmet"));
});

it("verifyStory: calls executor and returns pass when verifier says all met", async () => {
	repoDir = initRepo();
	const start = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
	writeFileSync(join(repoDir, "a.txt"), "next\n");
	execSync("git add a.txt", { cwd: repoDir });
	execSync("git commit -q -m change", { cwd: repoDir });

	const story = makeStory({ startCommit: start, acceptanceCriteria: ["AC1", "AC2", "AC3"] });
	const executor = new FakeExecutor(
		'<ac id="1" status="met" evidence="x"/>\n' +
			'<ac id="2" status="met" evidence="y"/>\n' +
			'<ac id="3" status="met" evidence="z"/>\n' +
			"<verification-result>PASS</verification-result>",
	);
	const outcome = await verifyStory({
		story,
		repoRoot: repoDir,
		agentConfig: AGENT_CONFIG,
		// biome-ignore lint/suspicious/noExplicitAny: test double
		agentExecutor: executor as any,
	});
	assert.equal(outcome.pass, true);
	assert.equal(executor.calls.length, 1);
	const call = executor.calls[0];
	assert.ok(call);
	assert.ok(call.prompt.includes("AC1"));
	assert.ok(call.prompt.includes("-base"));
});

it("verifyStory: surfaces failedAcs when verifier says FAIL", async () => {
	repoDir = initRepo();
	const start = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
	writeFileSync(join(repoDir, "a.txt"), "next\n");
	execSync("git add a.txt", { cwd: repoDir });
	execSync("git commit -q -m change", { cwd: repoDir });

	const story = makeStory({ startCommit: start });
	const executor = new FakeExecutor(
		'<ac id="1" status="met" evidence="ok"/>\n' +
			'<ac id="2" status="unmet" evidence="no test"/>\n' +
			'<ac id="3" status="partial" evidence="half done"/>\n' +
			"<verification-result>FAIL</verification-result>",
	);
	const outcome = await verifyStory({
		story,
		repoRoot: repoDir,
		agentConfig: AGENT_CONFIG,
		// biome-ignore lint/suspicious/noExplicitAny: test double
		agentExecutor: executor as any,
	});
	assert.equal(outcome.pass, false);
	assert.equal(outcome.failedAcs.length, 2);
	assert.deepEqual(outcome.failedAcs.map((f) => f.id).sort(), ["2", "3"]);
});

it("failedAcsToQuestions: resolves numeric ids into AC text", () => {
	const story = makeStory({
		acceptanceCriteria: ["Handler exists", "Test added", "Logs emitted"],
	});
	const qs = failedAcsToQuestions(story, [
		{ id: "2", status: "unmet", evidence: "no test file" },
		{ id: "3", status: "partial", evidence: "only one log call" },
	]);
	assert.equal(qs.length, 2);
	assert.ok(qs[0]?.includes("Test added"));
	assert.ok(qs[0]?.includes("no test file"));
	assert.ok(qs[1]?.includes("Logs emitted"));
	assert.ok(qs[1]?.includes("only one log call"));
});

it("failedAcsToQuestions: falls back to raw id when it is not a valid index", () => {
	const story = makeStory({ acceptanceCriteria: ["One", "Two"] });
	const qs = failedAcsToQuestions(story, [
		{ id: "bogus", status: "unmet", evidence: "??" },
		{ id: "99", status: "unmet", evidence: "out of range" },
	]);
	assert.ok(qs[0]?.includes("bogus"));
	assert.ok(qs[1]?.includes("99"));
});
