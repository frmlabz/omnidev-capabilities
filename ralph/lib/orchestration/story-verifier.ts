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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderVariantConfig, Story } from "../types.js";
import type { AgentExecutor } from "./agent-runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Ralph-owned verifier prompt (not an `agent.toml` subagent). */
export const VERIFIER_PROMPT_PATH = join(__dirname, "verifier-prompt.md");

/** Hard cap on diff size fed to the verifier. */
export const MAX_DIFF_CHARS = 3000;

let cachedSystemPrompt: string | null = null;

function getSystemPrompt(): string {
	if (cachedSystemPrompt === null) {
		cachedSystemPrompt = readFileSync(VERIFIER_PROMPT_PATH, "utf-8");
	}
	return cachedSystemPrompt;
}

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
	const systemPrompt = getSystemPrompt();
	const acsBlock = acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");
	return `${systemPrompt}

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
 * Render failed ACs as user-facing question strings that get appended to
 * a story's questions list when the verifier rejects it. The dev agent
 * picks them up on the retry iteration.
 */
export function failedAcsToQuestions(
	_story: Story,
	acceptanceCriteria: string[],
	failedAcs: FailedAc[],
): string[] {
	return failedAcs.map((fa) => {
		const idx = Number(fa.id);
		const acText =
			Number.isFinite(idx) && idx >= 1 && idx <= acceptanceCriteria.length
				? acceptanceCriteria[idx - 1]
				: fa.id;
		return `Verification ${fa.status}: AC "${acText}" — ${fa.evidence}`;
	});
}
