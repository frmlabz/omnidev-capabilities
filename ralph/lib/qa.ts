/**
 * Ralph QA Utilities
 *
 * Prompt generation, result parsing, and report management for PRD QA.
 * The orchestration loop itself lives in orchestration/engine.ts.
 *
 * QA runs in two steps per FR-5:
 *   1. General pass — story AC sections + `[ralph.qa].instructions`.
 *   2. Plugin pass — for each `[ralph.qa.platforms.<name>]` with a plugin,
 *      inject the capability's `ralph-qa.md` verbatim. Skipped entirely when
 *      no platforms declare a plugin.
 *
 * Both steps must emit `<qa-result>PRD_VERIFIED</qa-result>` for the PRD to
 * advance to `completed`.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getStatusDir } from "./core/paths.js";
import { findPRDLocation, getPRD, getProgress, getQAResultsDir, getSpec } from "./state.js";
import type { PRD, QAReport, QAResult, RalphConfig } from "./types.js";
import { getVerification } from "./verification.js";

const DEFAULT_DOCS_GLOB = "docs/**/*.md";

/**
 * Resolve the capability root used to locate QA plugins.
 * `OMNIDEV_CAPABILITIES_ROOT` wins; otherwise falls back to the parent
 * directory of this package (the monorepo layout ralph ships in).
 */
function resolveCapabilitiesRoot(): string {
	const fromEnv = process.env["OMNIDEV_CAPABILITIES_ROOT"];
	if (fromEnv) return fromEnv;
	// The ralph capability lives at <capabilities-root>/ralph; go one level up.
	return join(import.meta.dirname ?? __dirname, "..", "..");
}

/**
 * Resolve the absolute path to a QA plugin's `ralph-qa.md`.
 */
export function resolveQAPluginPath(pluginId: string): string {
	return join(resolveCapabilitiesRoot(), pluginId, "ralph-qa.md");
}

interface ResolvedPlatform {
	name: string;
	plugin?: string;
	pluginPath?: string;
	pluginContent?: string;
}

/**
 * Read declared QA platforms from config and, for platforms with a plugin,
 * load the capability's `ralph-qa.md`. Missing plugin files are hard failures
 * per FR-5.
 */
async function loadQAPlatforms(config: RalphConfig): Promise<ResolvedPlatform[]> {
	const platforms = config.qa?.platforms ?? {};
	const resolved: ResolvedPlatform[] = [];
	for (const [name, platform] of Object.entries(platforms)) {
		if (!platform.plugin) {
			resolved.push({ name });
			continue;
		}
		const pluginPath = resolveQAPluginPath(platform.plugin);
		if (!existsSync(pluginPath)) {
			throw new Error(
				`QA platform "${name}" references plugin "${platform.plugin}" but ${pluginPath} does not exist.`,
			);
		}
		const pluginContent = await readFile(pluginPath, "utf-8");
		resolved.push({ name, plugin: platform.plugin, pluginPath, pluginContent });
	}
	return resolved;
}

/**
 * Concatenate the `## Acceptance Criteria` sections from every completed story
 * file into a single markdown block. Fed into the step-1 QA prompt so the QA
 * agent knows exactly what has already been verified at code level.
 */
async function collectStoryAcceptanceCriteria(
	projectName: string,
	repoRoot: string,
	prd: PRD,
): Promise<string> {
	const status = findPRDLocation(projectName, repoRoot, prd.name);
	if (!status) return "";
	const prdDir = join(getStatusDir(projectName, repoRoot, status), prd.name);

	const sections: string[] = [];
	for (const story of prd.stories) {
		if (story.status !== "completed") continue;
		const filePath = join(prdDir, story.promptPath);
		if (!existsSync(filePath)) continue;
		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			continue;
		}
		const headingRe = /^##\s+Acceptance Criteria\s*$/im;
		const match = content.match(headingRe);
		if (!match || match.index === undefined) continue;
		const after = content.slice(match.index + match[0].length);
		const nextHeading = after.search(/^##\s+/m);
		const block = (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();
		if (!block) continue;
		sections.push(`### ${story.id} — ${story.title}\n${block}`);
	}
	return sections.join("\n\n");
}

/**
 * Generate the step-1 (general) QA prompt for the agent.
 */
export async function generateQAPrompt(
	projectName: string,
	repoRoot: string,
	prdName: string,
	config: RalphConfig,
): Promise<string> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	const status = findPRDLocation(projectName, repoRoot, prdName);
	const prdDir = status ? `${getStatusDir(projectName, repoRoot, status)}/${prdName}` : "(unknown)";

	let specContent = "";
	try {
		specContent = await getSpec(projectName, repoRoot, prdName);
	} catch {
		specContent = "(spec.md not found)";
	}

	let verificationContent = "";
	try {
		verificationContent = await getVerification(projectName, repoRoot, prdName);
	} catch {
		verificationContent =
			"(verification.md not found - generate it first with 'omnidev ralph verify')";
	}

	let progressContent = "";
	try {
		progressContent = await getProgress(projectName, repoRoot, prdName);
	} catch {
		progressContent = "(no progress log)";
	}

	const storyAcceptanceCriteria = await collectStoryAcceptanceCriteria(projectName, repoRoot, prd);

	const projectInstructions =
		config.qa?.project_verification_instructions ||
		"Run project quality checks (lint, typecheck, tests) to ensure code quality.";

	const qaInstructions = config.qa?.instructions || "";
	const qaResultsDir = getQAResultsDir(projectName, repoRoot, prdName) || "qa-results";

	return `<Role>
QA engineer for the ${prd.name} feature. Your job is to verify the feature works correctly and probe for failures — invalid inputs, edge cases, error handling, and boundary conditions. A feature that passes the happy path but crashes on edge cases is not ready.
</Role>

<Context>

### PRD
- Name: ${prd.name}
- Spec: ${prdDir}/spec.md
- Progress: ${prdDir}/progress.txt (append QA session here)
- Verification: ${prdDir}/verification.md (update checkboxes here)
- QA Results: ${prdDir}/qa-results/

### Specification
\`\`\`markdown
${specContent}
\`\`\`

### Story Acceptance Criteria (code-level, already verified by the per-story verifier)
${storyAcceptanceCriteria || "(no story acceptance criteria recorded)"}

### Verification Checklist
\`\`\`markdown
${verificationContent}
\`\`\`

### Progress Log (Implementation Details)
\`\`\`
${progressContent}
\`\`\`

### Project Verification Instructions
${projectInstructions}

${qaInstructions ? `### QA Instructions\n${qaInstructions}\n` : ""}

### QA Results Directory
Save all evidence to: \`${qaResultsDir}/\`
- Screenshots: \`${qaResultsDir}/screenshots/\`
- API responses: \`${qaResultsDir}/api-responses/\`

### Documentation
- Docs glob: ${DEFAULT_DOCS_GLOB}

</Context>

<Investigation_Protocol>

### 1. Start a QA session in progress.txt

Append a new entry:
\`\`\`markdown
---

## [QA Session] ${new Date().toISOString().split("T")[0]}

**Quality Checks:**
(lint, typecheck, tests results)

**Verification Checklist:**
(update as you verify each item)

**Edge Case Probing:**
(document what you tried and results)

**Issues Found:**
(document any failures here)

---
\`\`\`

### 2. Run project quality checks first

Lint, typecheck, tests, formatting. If any fail, document and report QA_FAILED.

### 3. Verify the happy path

Go through the verification checklist systematically:
- Test each item
- Update verification.md — change \`[ ]\` to \`[x]\` for passing items
- Save evidence (screenshots, API responses) under \`${qaResultsDir}/\`

### 4. Verify documentation completeness

- Check the affected files under **${DEFAULT_DOCS_GLOB}**
- Confirm behavior, commands, config, APIs, and workflows introduced by this PRD are documented where needed
- If docs are missing or stale, report QA_FAILED
- Update the documentation-related checkboxes in verification.md

### 5. Probe for failures (edge cases)

For each feature, test these categories as applicable:

**Input edge cases:** empty strings, null, whitespace-only, boundary values (0, -1, MAX_INT), very long strings, special characters (\`<script>\`, SQL injection strings), wrong types

**API edge cases:** missing required fields, extra unexpected fields, wrong HTTP methods, malformed JSON, large payloads

**UI edge cases (if applicable):** double-click submission, navigation during submit, back button after submit, refresh during operations, empty states, loading states

**Error handling:** network failure, timeouts, 500 errors, 404s, validation error messages

**Security:** unauthenticated access to protected resources, cross-user data access, sensitive data in responses/logs

### 6. Update verification.md with final results

Mark all verified items: \`[x]\` for pass, \`[ ]\` for fail with notes explaining why.

### 7. Document findings in progress.txt

Complete the QA session entry. Be specific: what input caused what failure.

### 8. Output final signal

PRD_VERIFIED only if happy path, documentation checks, and edge cases all pass.

</Investigation_Protocol>

<Output_Format>

These signals determine PRD state transitions:
- \`<qa-result>PRD_VERIFIED</qa-result>\` → PRD moves to completed
- \`<qa-result>QA_FAILED</qa-result>\` → fix story created, PRD moves back to in_progress

Create a detailed report, then output your signal:

**If ALL checks pass:**
\`\`\`
<qa-result>PRD_VERIFIED</qa-result>
\`\`\`

**If ANY checks fail:**
\`\`\`
<qa-result>QA_FAILED</qa-result>
<issues>
- Issue description 1
- Issue description 2
</issues>
\`\`\`

### Example report

\`\`\`markdown
# QA Report: ${prd.name}

## Project Quality Checks
- [x] Linting: PASS
- [x] Type checking: PASS
- [ ] Tests: FAIL - 2 tests failed in auth.test.ts

## Verification Results

### Passed
- [x] User can log in
- [x] Dashboard loads correctly
- [x] Relevant docs under docs/**/*.md were updated

### Failed
- [ ] User profile shows wrong email - Screenshot: screenshots/issue-001.png

## Summary
- Total: 10
- Passed: 8
- Failed: 2
\`\`\`

</Output_Format>

<Circuit_Breaker>
If quality checks fail 3 times in a row, stop retrying and report QA_FAILED with a summary of what's failing and why, rather than looping indefinitely.
</Circuit_Breaker>

<Failure_Modes_To_Avoid>
- **Happy-path-only QA** — verifying the feature "works" without probing edge cases misses the bugs users will hit
- **Untraceable results** — always update progress.txt and verification.md so the next developer (or fix agent) knows what was verified
- **Missing signal** — the orchestrator needs the \`<qa-result>\` signal to proceed; omitting it requires manual intervention
</Failure_Modes_To_Avoid>
`;
}

/**
 * Generate the step-2 (plugin) QA prompt.
 *
 * Returns null when no declared platform has a plugin — in which case the
 * engine should skip step 2 entirely per FR-5.
 */
export async function generateQAPluginPrompt(
	projectName: string,
	repoRoot: string,
	prdName: string,
	config: RalphConfig,
	step1Summary: string,
): Promise<string | null> {
	const platforms = await loadQAPlatforms(config);
	const withPlugin = platforms.filter((p) => p.plugin && p.pluginContent);
	if (withPlugin.length === 0) return null;

	const prd = await getPRD(projectName, repoRoot, prdName);
	const status = findPRDLocation(projectName, repoRoot, prdName);
	const prdDir = status ? `${getStatusDir(projectName, repoRoot, status)}/${prdName}` : "(unknown)";
	const storyAcceptanceCriteria = await collectStoryAcceptanceCriteria(projectName, repoRoot, prd);
	const qaResultsDir = getQAResultsDir(projectName, repoRoot, prdName) || "qa-results";

	const platformSections = platforms
		.map((p) => {
			if (p.plugin && p.pluginContent) {
				return `## Platform: ${p.name} (via ${p.plugin})\n\n${p.pluginContent}`;
			}
			return `## Platform: ${p.name} — no plugin, skip`;
		})
		.join("\n\n");

	return `<Role>
Platform QA engineer for ${prd.name}. Step 1 of QA has already run. Your job is the platform-specific pass below.
</Role>

<Context>

### PRD
- Name: ${prd.name}
- Spec: ${prdDir}/spec.md
- Progress: ${prdDir}/progress.txt
- QA Results: ${prdDir}/qa-results/

### Step 1 Summary
${step1Summary || "(no summary provided)"}

### Story Acceptance Criteria (code-level, already verified)
${storyAcceptanceCriteria || "(no story acceptance criteria recorded)"}

### QA Results Directory
Save all evidence to: \`${qaResultsDir}/\`.

</Context>

<Platforms>

${platformSections}

</Platforms>

<Output_Format>

Run the platform-specific QA passes above. When done, output exactly one signal:

**If every platform pass succeeds:**
\`\`\`
<qa-result>PRD_VERIFIED</qa-result>
\`\`\`

**If any platform pass fails:**
\`\`\`
<qa-result>QA_FAILED</qa-result>
<issues>
- Issue description 1
- Issue description 2
</issues>
\`\`\`
</Output_Format>
`;
}

/**
 * Detect QA result signal from agent output
 */
export function detectQAResult(output: string): "verified" | "failed" | null {
	if (output.includes("<qa-result>PRD_VERIFIED</qa-result>")) {
		return "verified";
	}
	if (output.includes("<qa-result>QA_FAILED</qa-result>")) {
		return "failed";
	}
	return null;
}

/**
 * Detect healthcheck fix result signal from agent output
 */
export function detectHealthCheckResult(output: string): "fixed" | "not_fixable" | null {
	if (output.includes("<healthcheck-result>FIXED</healthcheck-result>")) {
		return "fixed";
	}
	if (output.includes("<healthcheck-result>NOT_FIXABLE</healthcheck-result>")) {
		return "not_fixable";
	}
	return null;
}

/**
 * Extract issues from agent output
 */
export function extractIssues(output: string): string[] {
	const match = output.match(/<issues>([\s\S]*?)<\/issues>/);
	const issuesContent = match?.[1];
	if (!issuesContent) return [];

	return issuesContent
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("-"))
		.map((line) => line.slice(1).trim())
		.filter((line) => line.length > 0);
}

/**
 * Parse QA report from agent output
 */
export function parseQAReport(output: string, prdName: string): QAReport {
	const results: QAResult[] = [];
	let passed = 0;
	let failed = 0;

	const reportMatch = output.match(/<qa-report>([\s\S]*?)<\/qa-report>/);
	const reportContent: string = reportMatch?.[1] ?? output;

	const passedMatches = reportContent.matchAll(/- \[x\]\s*(.+?)(?:\n|$)/gi);
	for (const match of passedMatches) {
		const item = match[1]?.trim();
		if (item) {
			results.push({ item, passed: true });
			passed++;
		}
	}

	const failedMatches = reportContent.matchAll(
		/- \[ \]\s*(.+?)(?:\s*-\s*\*\*Reason:\*\*\s*(.+?))?(?:\n|$)/gi,
	);
	for (const match of failedMatches) {
		const item = match[1]?.trim();
		const reason = match[2]?.trim();
		if (item && !item.toLowerCase().includes("skipped")) {
			results.push({ item, passed: false, reason });
			failed++;
		}
	}

	return {
		prdName,
		timestamp: new Date().toISOString(),
		qaResults: results,
		summary: {
			total: passed + failed,
			passed,
			failed,
		},
		agentOutput: output,
	};
}

/**
 * Save QA report to file
 */
export async function saveQAReport(
	projectName: string,
	repoRoot: string,
	prdName: string,
	report: QAReport,
): Promise<string> {
	const qaResultsDir = getQAResultsDir(projectName, repoRoot, prdName);
	if (!qaResultsDir) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	const reportPath = join(qaResultsDir, "report.md");

	const lines: string[] = [];
	lines.push(`# QA Report: ${prdName}`);
	lines.push("");
	lines.push(`**Verified:** ${report.timestamp}`);
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push(`- **Total:** ${report.summary.total}`);
	lines.push(`- **Passed:** ${report.summary.passed}`);
	lines.push(`- **Failed:** ${report.summary.failed}`);
	lines.push("");

	if (report.qaResults.length > 0) {
		const passedResults = report.qaResults.filter((r) => r.passed);
		const failedResults = report.qaResults.filter((r) => !r.passed);

		if (passedResults.length > 0) {
			lines.push("## Passed");
			lines.push("");
			for (const result of passedResults) {
				lines.push(`- [x] ${result.item}`);
			}
			lines.push("");
		}

		if (failedResults.length > 0) {
			lines.push("## Failed");
			lines.push("");
			for (const result of failedResults) {
				if (result.reason) {
					lines.push(`- [ ] ${result.item} - **Reason:** ${result.reason}`);
				} else {
					lines.push(`- [ ] ${result.item}`);
				}
			}
			lines.push("");
		}
	}

	lines.push("---");
	lines.push("");
	lines.push("## Full Agent Output");
	lines.push("");
	lines.push("```");
	lines.push(report.agentOutput || "(no output)");
	lines.push("```");

	await writeFile(reportPath, lines.join("\n"));
	return reportPath;
}

/**
 * Read previous QA report and extract failed items
 */
export async function getPreviousFailures(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string[] | null> {
	const qaResultsDir = getQAResultsDir(projectName, repoRoot, prdName);
	if (!qaResultsDir) return null;

	const reportPath = join(qaResultsDir, "report.md");
	if (!existsSync(reportPath)) return null;

	try {
		const content = await readFile(reportPath, "utf-8");

		const failures: string[] = [];
		const failedMatches = content.matchAll(
			/- \[ \]\s*(.+?)(?:\s*-\s*\*\*Reason:\*\*\s*(.+?))?(?:\n|$)/gi,
		);
		for (const match of failedMatches) {
			const item = match[1]?.trim();
			const reason = match[2]?.trim();
			if (item) {
				failures.push(reason ? `${item} (Previous failure: ${reason})` : item);
			}
		}

		const issuesMatch = content.match(/<issues>([\s\S]*?)<\/issues>/);
		if (issuesMatch?.[1]) {
			const issues = issuesMatch[1]
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith("-"))
				.map((line) => line.slice(1).trim())
				.filter((line) => line.length > 0);
			failures.push(...issues);
		}

		return failures.length > 0 ? failures : null;
	} catch {
		return null;
	}
}

/**
 * Generate a focused reQA prompt for previously failed items
 */
export async function generateQARetestPrompt(
	projectName: string,
	repoRoot: string,
	prdName: string,
	previousFailures: string[],
	config: RalphConfig,
): Promise<string> {
	const status = findPRDLocation(projectName, repoRoot, prdName);
	const prdDir = status ? `${getStatusDir(projectName, repoRoot, status)}/${prdName}` : "(unknown)";
	const qaResultsDir = getQAResultsDir(projectName, repoRoot, prdName) || "qa-results";

	const projectInstructions =
		config.qa?.project_verification_instructions ||
		"Run project quality checks (lint, typecheck, tests) to ensure code quality.";
	const qaInstructions = config.qa?.instructions || "";

	return `<Role>
ReQA agent. Verify that previously failed QA items have been fixed.
</Role>

<Scope>
This is a focused reQA, not a full QA run. Verify only the ${previousFailures.length} item(s) that previously failed. Re-running the entire suite wastes effort on items that already passed.
</Scope>

<Previous_Failures>

${previousFailures.map((f, i) => `${i + 1}. ${f}`).join("\n")}

</Previous_Failures>

<Investigation_Protocol>

1. For each previously failed item above:
   - Verify if it has been fixed
   - Document the result (pass/fail)
   - If still failing, explain why

2. Run project quality checks (lint, typecheck, tests) to ensure fixes didn't break anything

**Project verification instructions:** ${projectInstructions}

${qaInstructions ? `**QA instructions:** ${qaInstructions}\n` : ""}

**QA results directory:** \`${qaResultsDir}/\`

</Investigation_Protocol>

<Output_Format>

These signals determine PRD state transitions. The orchestrator parses them to decide whether to complete or loop back for fixes.

**If ALL previously failed items are now fixed:**
\`\`\`
<qa-result>PRD_VERIFIED</qa-result>
\`\`\`

**If ANY items still fail:**
\`\`\`
<qa-result>QA_FAILED</qa-result>
<issues>
- Issue description 1
- Issue description 2
</issues>
\`\`\`

</Output_Format>

<File_Paths>
- PRD: ${prdDir}/prd.json
- Progress: ${prdDir}/progress.txt
- Verification: ${prdDir}/verification.md
- QA Results: ${prdDir}/qa-results/
</File_Paths>
`;
}
