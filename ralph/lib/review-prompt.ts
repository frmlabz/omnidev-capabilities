/**
 * Ralph Review Prompt Generator
 *
 * Generates prompts for review agents, fix agents, external review,
 * and finalize steps. Parses review results from agent output.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findPRDLocation, getSpec } from "./state.js";
import type { PRD, ReviewFinding, ReviewRoundResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBAGENTS_DIR = join(__dirname, "..", "subagents", "review");

/**
 * Load a subagent prompt from the review subagent directory.
 * Reads from subagents/review/<type>/prompt.md (agent.toml + prompt.md format).
 */
async function loadSubagentDefinition(reviewType: string): Promise<string> {
	const filePath = join(SUBAGENTS_DIR, reviewType, "prompt.md");
	return (await readFile(filePath, "utf-8")).trim();
}

/**
 * Generate a prompt for a review agent
 */
export async function generateReviewPrompt(
	projectName: string,
	repoRoot: string,
	prdName: string,
	reviewType: string,
	prd: PRD,
	gitDiff: string,
	isSecondReview: boolean,
): Promise<string> {
	const agentDefinition = await loadSubagentDefinition(reviewType);
	const prdStatus = findPRDLocation(projectName, repoRoot, prdName) ?? "in_progress";

	let specContent = "";
	try {
		specContent = await getSpec(projectName, repoRoot, prdName);
	} catch {
		specContent = "(spec.md not found)";
	}

	const acceptanceCriteria = prd.stories
		.map((s) => `### ${s.id}: ${s.title}\n${s.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`)
		.join("\n\n");

	const secondReviewNote = isSecondReview
		? `\n\nThis is the second review pass. Focus only on CRITICAL and MAJOR severity issues. Approve if only MINOR or SUGGESTION-level issues remain.`
		: "";

	return `# Code Review: ${prdName} (${reviewType})

${agentDefinition}

<Review_Context>
**PRD:** ${prd.name} — ${prd.description}
**PRD Status:** ${prdStatus}
**Review Type:** ${reviewType}${secondReviewNote}

**Spec:**
\`\`\`markdown
${specContent.slice(0, 3000)}${specContent.length > 3000 ? "\n...(truncated)" : ""}
\`\`\`

**Acceptance Criteria:**
${acceptanceCriteria}

**Git Diff (changes to review):**
\`\`\`diff
${gitDiff.slice(0, 50000)}${gitDiff.length > 50000 ? "\n...(truncated)" : ""}
\`\`\`
</Review_Context>

Begin your review now.
`;
}

/**
 * Generate a prompt for the fix agent to resolve review findings
 */
export function generateFixPrompt(prdName: string, prd: PRD, findings: ReviewFinding[]): string {
	const groupedFindings = new Map<string, ReviewFinding[]>();
	for (const finding of findings) {
		const key = finding.file;
		if (!groupedFindings.has(key)) {
			groupedFindings.set(key, []);
		}
		groupedFindings.get(key)!.push(finding);
	}

	let findingsList = "";
	for (const [file, fileFindings] of groupedFindings) {
		findingsList += `\n### ${file}\n`;
		for (const f of fileFindings) {
			findingsList += `- [${f.severity.toUpperCase()}]${f.line ? ` line ${f.line}` : ""} — ${f.issue} (reviewer: ${f.reviewer})\n`;
		}
	}

	return `<Role>
You are a fix agent. You resolve code review findings by making targeted fixes to the codebase. Fix each issue, run quality checks, and commit.
</Role>

<Context>
**PRD:** ${prd.name} — ${prd.description}
</Context>

<Findings_To_Fix>
${findingsList}
</Findings_To_Fix>

<Workflow>

1. For each finding, read the file and understand the issue in context
2. Make the minimal fix that resolves the issue
3. After all fixes, run quality checks:
   \`\`\`bash
   npm run check
   npm test
   \`\`\`
4. Commit with message: \`fix: [review] resolve code review findings for ${prdName}\`
5. Signal completion:
   \`\`\`
   <promise>COMPLETE</promise>
   \`\`\`

</Workflow>

<Constraints>
- Fix only the listed findings — do not refactor surrounding code
- If a finding is a false positive (the code is actually correct), skip it and note why
- Keep fixes minimal and targeted — the goal is to resolve the specific issues, not improve the code broadly
- Run quality checks before committing to avoid introducing new issues
</Constraints>
`;
}

/**
 * Generate a prompt for external review tools (codex, etc.)
 */
export function generateExternalReviewPrompt(prdName: string, prd: PRD, gitDiff: string): string {
	const acceptanceCriteria = prd.stories
		.map((s) => `### ${s.id}: ${s.title}\n${s.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`)
		.join("\n\n");

	return `# Code Review Request: ${prdName}

Review the following code changes for the PRD "${prd.name}" (${prd.description}).

## Acceptance Criteria

${acceptanceCriteria}

## Code Changes

\`\`\`diff
${gitDiff.slice(0, 50000)}${gitDiff.length > 50000 ? "\n...(truncated)" : ""}
\`\`\`

## Review Focus

1. **Correctness**: Does the implementation match the acceptance criteria?
2. **Security**: Are there any security vulnerabilities?
3. **Quality**: Are there bugs, race conditions, or error handling gaps?
4. **Simplicity**: Is there unnecessary complexity or over-engineering?

## Response Format

List any issues found using this format:

- [CRITICAL] file.ts:42 - Description of the issue
- [MAJOR] file.ts:88 - Description of the issue
- [MINOR] file.ts:120 - Description of the issue
- [SUGGESTION] file.ts:150 - Description of the issue

If no issues are found, respond with "APPROVE - no issues found."
`;
}

/**
 * Generate a prompt for the finalize step
 */
export function generateFinalizePrompt(prdName: string, prd: PRD, customPrompt?: string): string {
	if (customPrompt) {
		return `# Finalize: ${prdName}

**PRD:** ${prd.name} — ${prd.description}

${customPrompt}

When done, signal completion:
\`\`\`
<promise>COMPLETE</promise>
\`\`\`
`;
	}

	return `# Finalize: ${prdName}

**PRD:** ${prd.name} — ${prd.description}

## Task

Perform final cleanup on the codebase after code review:

1. Review recent commits for this PRD
2. Clean up any debug statements, TODO comments, or temporary code
3. Ensure all quality checks pass:
   \`\`\`bash
   npm run check
   npm test
   \`\`\`
4. If changes were made, commit with: \`chore: [${prdName}] finalize after review\`

When done, signal completion:
\`\`\`
<promise>COMPLETE</promise>
\`\`\`
`;
}

/**
 * Parse review result from agent output.
 * Handles both structured XML output and freeform text.
 */
export function parseReviewResult(output: string, reviewType: string): ReviewRoundResult {
	const result: ReviewRoundResult = {
		reviewType,
		decision: "approve",
		findings: [],
	};

	// Try to parse structured <review-result> tag
	const resultMatch = output.match(
		/<review-result>\s*(APPROVE|REQUEST_CHANGES)\s*<\/review-result>/i,
	);
	if (resultMatch?.[1]) {
		result.decision = resultMatch[1].toLowerCase() === "approve" ? "approve" : "request_changes";
	}

	// Parse findings from <review-findings> tag
	const findingsMatch = output.match(/<review-findings>([\s\S]*?)<\/review-findings>/i);
	const findingsText = findingsMatch?.[1] ?? output;

	// Parse individual findings: - [SEVERITY] file:line - description
	const findingPattern =
		/- \[(CRITICAL|MAJOR|MINOR|SUGGESTION)\]\s+([^\s:]+?)(?::(\d+))?\s*[-—]\s*(.+)/gi;
	for (const match of findingsText.matchAll(findingPattern)) {
		const severity = match[1];
		const file = match[2];
		const lineStr = match[3];
		const issue = match[4];
		if (!severity || !file || !issue) continue;
		result.findings.push({
			severity: severity.toLowerCase() as ReviewFinding["severity"],
			file,
			line: lineStr ? Number.parseInt(lineStr, 10) : undefined,
			issue: issue.trim(),
			reviewer: reviewType,
		});
	}

	// If we found findings but no explicit decision, infer from findings
	if (!resultMatch && result.findings.length > 0) {
		const hasCriticalOrMajor = result.findings.some(
			(f) => f.severity === "critical" || f.severity === "major",
		);
		result.decision = hasCriticalOrMajor ? "request_changes" : "approve";
	}

	// If text says APPROVE but no structured tag
	if (!resultMatch && result.findings.length === 0) {
		const approveMatch = /\bAPPROVE\b/i.test(output);
		result.decision = approveMatch ? "approve" : "approve"; // Default to approve if no signal
	}

	return result;
}
