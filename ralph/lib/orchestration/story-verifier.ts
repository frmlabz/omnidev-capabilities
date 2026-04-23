/**
 * Ralph per-story verifier
 *
 * Runs after the dev agent signals a story is complete. Feeds the story's
 * acceptance criteria (read from the story markdown file) and the git diff
 * of work done on that story to a cheap checklist LLM, which emits a
 * structured per-AC verdict.
 *
 * A single FAIL triggers one retry (the story is reverted to in_progress with
 * the failed ACs appended to its questions). A second FAIL blocks the story.
 * The retry logic lives in the engine; this module is just the runner + parser.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ProviderVariantConfig, Story } from "../types.js";
import type { AgentExecutor } from "./agent-runner.js";

/** Hard cap on diff size fed to the verifier. */
export const MAX_DIFF_CHARS = 3000;

/**
 * System prompt for the per-story checklist verifier. Kept in sync with
 * `subagents/story-verifier/prompt.md` (the Claude Code subagent variant).
 * Inlined here so the ralph bundle is self-contained and not dependent on
 * reading a sibling file at runtime.
 */
const VERIFIER_SYSTEM_PROMPT = `<Role>
You verify that a completed story's git diff satisfies every one of its acceptance criteria. You are a checklist auditor — not a code reviewer.

Do not comment on code quality, style, design, or test coverage. Your only job is to answer, for each AC in order: did the diff deliver it?
</Role>

<Process>
1. Read the story title and numbered acceptance criteria.
2. Read the git diff. Look for concrete evidence that each criterion is met.
3. For each AC in the order given, emit exactly one \`<ac>\` line.
4. After all \`<ac>\` lines, emit exactly one \`<verification-result>\` line.
</Process>

<Output_Format>
For each AC, emit a self-closing XML tag on its own line:

\`\`\`
<ac id="<numeric index>" status="met|partial|unmet" evidence="<filename:line or brief quote, or reason it is missing>"/>
\`\`\`

\`id\` must be the 1-based index of the AC in the list you were given.

After every \`<ac>\` line, emit exactly one of:

\`\`\`
<verification-result>PASS</verification-result>
<verification-result>FAIL</verification-result>
\`\`\`

**PASS** = every AC is \`met\`. **FAIL** = at least one AC is \`partial\` or \`unmet\`.

Do not emit any other text after the \`<verification-result>\` line. You may emit up to one short paragraph of reasoning before the first \`<ac>\` line; nothing between or after the structured lines.
</Output_Format>

<Rules>
- Quote the diff (or cite \`filename:line\`) for evidence. Do not speculate about behaviour that is not visible in the diff.
- An AC that asks for tests is \`met\` only if a test was actually added or updated.
- An AC that cannot be fully verified from a diff alone (e.g. "works on Windows", "handles 10k concurrent users") — mark \`met\` only if the diff contains the mechanism being asked for. Mark \`partial\` if the mechanism is present but clearly incomplete.
- Do not invent ACs. Use only the ones listed in the \`<Story>\` block.
- If the diff is empty, every AC is \`unmet\` with evidence \`"no diff produced for this story"\`.
- Do not be generous. A missing piece is \`unmet\`, not \`partial\`. \`partial\` is for genuinely half-done work where the intent is visible but the delivery is not complete.
</Rules>

<Examples>

**Good output (story had 3 ACs):**

\`\`\`
The diff adds the new endpoint and its tests. Logging is not present.

<ac id="1" status="met" evidence="src/api/users.ts:42 — POST /users handler added"/>
<ac id="2" status="met" evidence="src/api/users.test.ts:15 — new test covers 400 on invalid body"/>
<ac id="3" status="unmet" evidence="no structured logging call found in the new handler"/>
<verification-result>FAIL</verification-result>
\`\`\`

**Bad output:**

\`\`\`
The implementation looks good overall. I'd suggest adding more tests.
<verification-result>PASS</verification-result>
\`\`\`

This is bad because it skips the per-AC accounting, which is the entire point of the task.

</Examples>
`;

export interface FailedAc {
	/** 1-based index into the story file's acceptance criteria (or the raw id emitted by the verifier). */
	id: string;
	status: "partial" | "unmet";
	evidence: string;
}

export interface VerificationOutcome {
	pass: boolean;
	failedAcs: FailedAc[];
	rawOutput: string;
	/** True when the verifier was skipped because no start commit was recorded. */
	skipped?: boolean;
}

/**
 * Read the `## Acceptance Criteria` section from a story markdown file.
 * Returns an array of criterion lines with leading list/checkbox markers stripped.
 * Hard-fails (throws) when the section is missing — per FR-1, acceptance
 * criteria must live in the story file.
 */
export function readStoryAcceptanceCriteria(storyFilePath: string): string[] {
	const content = readFileSync(storyFilePath, "utf-8");
	const headingRe = /^##\s+Acceptance Criteria\s*$/im;
	const match = content.match(headingRe);
	if (!match || match.index === undefined) {
		throw new Error(`Story file ${storyFilePath} is missing '## Acceptance Criteria' section.`);
	}
	const after = content.slice(match.index + match[0].length);
	const nextHeading = after.search(/^##\s+/m);
	const block = nextHeading === -1 ? after : after.slice(0, nextHeading);
	const items: string[] = [];
	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		// list marker or checkbox marker
		const stripped = line
			.replace(/^[-*+]\s*/, "")
			.replace(/^\[[ xX]\]\s*/, "")
			.trim();
		if (!stripped) continue;
		items.push(stripped);
	}
	if (items.length === 0) {
		throw new Error(
			`Story file ${storyFilePath} has an '## Acceptance Criteria' section but no items.`,
		);
	}
	return items;
}

/**
 * Shell out to git to collect the diff of work produced during this story.
 * Uses the story's startCommit to scope the diff.
 */
export function getStoryDiff(repoRoot: string, startCommit: string | undefined): string {
	if (!startCommit) {
		return "";
	}
	let raw: string;
	try {
		raw = execSync(`git diff ${startCommit}..HEAD`, {
			cwd: repoRoot,
			encoding: "utf-8",
			maxBuffer: 50 * 1024 * 1024,
		});
	} catch {
		return "";
	}
	if (raw.length > MAX_DIFF_CHARS) {
		return `${raw.slice(0, MAX_DIFF_CHARS)}\n...(truncated at ${MAX_DIFF_CHARS} chars)`;
	}
	return raw;
}

/**
 * Capture the current HEAD SHA. Used to tag a story on first pending → in_progress.
 * Returns undefined on any error so the caller can proceed without blocking.
 */
export function captureCurrentCommit(repoRoot: string): string | undefined {
	try {
		return execSync("git rev-parse HEAD", {
			cwd: repoRoot,
			encoding: "utf-8",
		}).trim();
	} catch {
		return undefined;
	}
}

export function generateVerifierPrompt(
	story: Story,
	acceptanceCriteria: string[],
	diff: string,
): string {
	const acsBlock = acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
	return `${VERIFIER_SYSTEM_PROMPT}

<Story>
ID: ${story.id}
Title: ${story.title}

Acceptance Criteria:
${acsBlock}
</Story>

<Diff>
\`\`\`diff
${diff}
\`\`\`
</Diff>`;
}

const AC_RE =
	/<(?:ac|check)\s+id="([^"]*)"\s+status="(met|partial|unmet|pass|fail)"\s+evidence="([^"]*)"\s*\/>/gi;
const RESULT_RE = /<verification-result>\s*(PASS|FAIL)\s*<\/verification-result>/i;

/**
 * Parse the verifier's output into a structured outcome.
 *
 * The verifier emits either `<ac>` or `<check>` tags with status values
 * (met/partial/unmet or pass/fail). When output is malformed we bias
 * toward FAIL.
 */
export function parseVerifierOutput(output: string): VerificationOutcome {
	const failedAcs: FailedAc[] = [];
	for (const match of output.matchAll(AC_RE)) {
		const id = match[1] ?? "";
		const rawStatus = (match[2] ?? "").toLowerCase();
		const evidence = match[3] ?? "";
		const normalized: "met" | "partial" | "unmet" =
			rawStatus === "pass" || rawStatus === "met"
				? "met"
				: rawStatus === "partial"
					? "partial"
					: "unmet";
		if (normalized !== "met") {
			failedAcs.push({ id, status: normalized, evidence });
		}
	}
	const resultMatch = output.match(RESULT_RE);
	const declaredPass = resultMatch ? (resultMatch[1] ?? "").toUpperCase() === "PASS" : false;
	const pass = declaredPass && failedAcs.length === 0;
	return { pass, failedAcs, rawOutput: output };
}

export interface VerifyStoryParams {
	story: Story;
	/** Absolute path to the story markdown file (resolved by caller). */
	storyFilePath: string;
	repoRoot: string;
	providerVariant: ProviderVariantConfig;
	agentExecutor: AgentExecutor;
	signal?: AbortSignal;
}

/**
 * Full verification flow: read AC from story file, collect diff, prompt agent, parse result.
 * Returns skipped=true with pass=true when there is no work to verify
 * (missing startCommit on a legacy story).
 */
export async function verifyStory(params: VerifyStoryParams): Promise<VerificationOutcome> {
	if (!params.story.startCommit) {
		return {
			pass: true,
			failedAcs: [],
			rawOutput: "",
			skipped: true,
		};
	}

	const acceptanceCriteria = readStoryAcceptanceCriteria(params.storyFilePath);

	const diff = getStoryDiff(params.repoRoot, params.story.startCommit);
	if (!diff.trim()) {
		return {
			pass: false,
			failedAcs: acceptanceCriteria.map((_, i) => ({
				id: String(i + 1),
				status: "unmet" as const,
				evidence: "no diff produced for this story",
			})),
			rawOutput: "",
		};
	}

	const prompt = generateVerifierPrompt(params.story, acceptanceCriteria, diff);
	const result = await params.agentExecutor.run(prompt, params.providerVariant, {
		stream: false,
		signal: params.signal,
	});
	return parseVerifierOutput(result.output);
}

/**
 * Build the fix-agent prompt for a story that failed verification. The fix
 * agent is given the specific failed ACs, the scoped diff, and instructions
 * to fix only those items (no re-implementation, no story-file edits). It
 * runs inline between the verifier and the next story — the story itself
 * stays `completed`.
 */
export function generateVerifierFixPrompt(
	story: Story,
	storyFilePath: string,
	acceptanceCriteria: string[],
	failedAcs: FailedAc[],
	diff: string,
): string {
	const failedBlock = failedAcs
		.map((fa) => {
			const idx = Number(fa.id);
			const acText =
				Number.isFinite(idx) && idx >= 1 && idx <= acceptanceCriteria.length
					? acceptanceCriteria[idx - 1]
					: `(unknown AC ${fa.id})`;
			return `- AC ${fa.id} [${fa.status}]: ${acText}\n  Evidence: ${fa.evidence}`;
		})
		.join("\n");

	return `<Role>
Targeted fix agent. A prior agent completed story ${story.id} but the per-story verifier found that some acceptance criteria were not delivered. Fix ONLY those items — do not re-implement the story or refactor unrelated code.
</Role>

<Context>
**Story:** ${story.id} — ${story.title}
**Story file:** \`${storyFilePath}\`

**Failed acceptance criteria (address each):**
${failedBlock}

**Diff of work done so far on this story:**
\`\`\`diff
${diff}
\`\`\`
</Context>

<Workflow>
1. Read the story file for full context on the listed ACs.
2. Fix only the listed items. Prefer the smallest possible change.
3. Run quality checks (typecheck, lint, tests). Fix any failures you introduce.
4. Commit with:
   \`\`\`bash
   git add .
   git commit -m "fix: [${story.id}] - address verification failures"
   \`\`\`
5. End your turn. Do not emit a completion signal.
</Workflow>

<Constraints>
- Fix only the listed failed ACs. No new features, no refactors.
- Do not modify the story file.
- Do not modify prd.json or any Ralph state files.
- If you cannot fix an item (e.g., missing dependency), explain why in the commit message and leave it for review.
</Constraints>
`;
}
