/**
 * Ralph Testing Utilities
 *
 * Prompt generation, result parsing, and report management for PRD testing.
 * The orchestration loop itself lives in orchestration/engine.ts.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findPRDLocation, getTestResultsDir, getPRD, getProgress, getSpec } from "./state.js";
import type { RalphConfig, TestReport, TestResult } from "./types.js";
import { getVerification } from "./verification.js";
import { getStatusDir } from "./core/paths.js";

/**
 * Playwriter instructions for web testing
 */
function getPlaywriterInstructions(): string {
	return `
## Web Testing with Playwriter MCP

You have access to the Playwriter MCP for browser automation.

### Session Setup

Create a session and your own page before any web testing. Using \`state.myPage\` instead of the default \`page\` prevents interference if multiple agents share a session.

\`\`\`bash
# Create a new session (outputs session id, e.g., 1)
playwriter session new

# Create your own page to avoid interference from other agents
playwriter -s 1 -e "state.myPage = await context.newPage()"

# Navigate to the app (use URL from testing instructions)
playwriter -s 1 -e "await state.myPage.goto('http://localhost:3000')"
\`\`\`

### Checking Page State

After any action, verify what happened:

\`\`\`bash
# Get accessibility snapshot (shows interactive elements with aria-ref)
playwriter -s 1 -e "console.log(await accessibilitySnapshot({ page: state.myPage }))"

# Or take a screenshot with labels for visual verification
playwriter -s 1 -e "await screenshotWithAccessibilityLabels({ page: state.myPage })"
\`\`\`

### Interacting with Elements

Use aria-ref from the accessibility snapshot:

\`\`\`bash
# Click an element
playwriter -s 1 -e "await state.myPage.locator('aria-ref=e5').click()"

# Fill an input
playwriter -s 1 -e "await state.myPage.locator('aria-ref=e10').fill('test value')"

# Wait for navigation
playwriter -s 1 -e "await state.myPage.waitForLoadState('domcontentloaded')"
\`\`\`

### Taking Screenshots for Evidence

Save screenshots to the test-results folder:

\`\`\`bash
# Screenshot on success
playwriter -s 1 -e "await state.myPage.screenshot({ path: 'test-results/screenshots/success-001.png', scale: 'css' })"

# Screenshot on failure
playwriter -s 1 -e "await state.myPage.screenshot({ path: 'test-results/screenshots/issue-001.png', scale: 'css' })"
\`\`\`

### Network Interception (for API testing via browser)

\`\`\`bash
# Set up request interception
playwriter -s 1 -e "state.requests = []; state.myPage.on('response', r => { if (r.url().includes('/api/')) state.requests.push({ url: r.url(), status: r.status() }) })"

# Trigger action that makes API call
playwriter -s 1 -e "await state.myPage.locator('aria-ref=e5').click()"

# Check captured requests
playwriter -s 1 -e "console.log(JSON.stringify(state.requests, null, 2))"
\`\`\`

### Session Management

\`\`\`bash
# List sessions
playwriter session list

# Reset if connection issues
playwriter session reset 1
\`\`\`

### Notes

- Use \`state.myPage\` instead of \`page\` to avoid conflicts with other agents
- Take screenshots of any issues you find
- Save API responses to test-results/api-responses/
- Clean up: \`playwriter -s 1 -e "await state.myPage.close()"\` when done
`;
}

/**
 * Generate the test prompt for the agent
 */
export async function generateTestPrompt(
	projectName: string,
	repoRoot: string,
	prdName: string,
	config: RalphConfig,
): Promise<string> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	const status = findPRDLocation(projectName, repoRoot, prdName);
	const prdDir = status ? `${getStatusDir(projectName, repoRoot, status)}/${prdName}` : "(unknown)";

	// Load all context files
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

	// Get project verification instructions from config
	const projectInstructions =
		config.testing?.project_verification_instructions ||
		"Run project quality checks (lint, typecheck, tests) to ensure code quality.";

	// Web testing instructions
	const webTestingEnabled = config.testing?.web_testing_enabled ?? false;
	const playwriterSection = webTestingEnabled ? getPlaywriterInstructions() : "";

	// Testing instructions (URLs, credentials, context)
	const testingInstructions = config.testing?.instructions || "";

	// Format PRD JSON (truncated for prompt size)
	const prdJson = JSON.stringify(prd, null, 2);

	// Get test results directory path
	const testResultsDir = getTestResultsDir(projectName, repoRoot, prdName) || "test-results";

	return `<Role>
QA engineer for the ${prd.name} feature. Your job is to verify the feature works correctly and probe for failures — invalid inputs, edge cases, error handling, and boundary conditions. A feature that passes the happy path but crashes on edge cases is not ready.
</Role>

<Context>

### PRD
\`\`\`json
${prdJson.slice(0, 3000)}${prdJson.length > 3000 ? "\n...(truncated)" : ""}
\`\`\`

### Specification
\`\`\`markdown
${specContent.slice(0, 5000)}${specContent.length > 5000 ? "\n...(truncated)" : ""}
\`\`\`

### Verification Checklist
\`\`\`markdown
${verificationContent}
\`\`\`

### Progress Log (Implementation Details)
\`\`\`
${progressContent.slice(0, 5000)}${progressContent.length > 5000 ? "\n...(truncated)" : ""}
\`\`\`

### Project Verification Instructions
${projectInstructions}

${testingInstructions ? `### Testing Instructions\n${testingInstructions}\n` : ""}

### Test Results Directory
Save all evidence to: \`${testResultsDir}/\`
- Screenshots: \`${testResultsDir}/screenshots/\`
- API responses: \`${testResultsDir}/api-responses/\`

### File Paths
- PRD: ${prdDir}/prd.json
- Spec: ${prdDir}/spec.md
- Progress: ${prdDir}/progress.txt (append testing session here)
- Verification: ${prdDir}/verification.md (update checkboxes here)
- Test Results: ${prdDir}/test-results/

</Context>

${playwriterSection}

<Investigation_Protocol>

### 1. Start a testing session in progress.txt

Append a new entry:
\`\`\`markdown
---

## [Testing Session] ${new Date().toISOString().split("T")[0]}

**Quality Checks:**
(lint, typecheck, tests results)

**Verification Checklist:**
(update as you test each item)

**Edge Case Testing:**
(document what you tried and results)

**Issues Found:**
(document any failures here)

---
\`\`\`

### 2. Run project quality checks first

Lint, typecheck, tests, formatting. If any fail, document and report PRD_FAILED.

### 3. Verify the happy path

Go through the verification checklist systematically:
- Test each item
- Update verification.md — change \`[ ]\` to \`[x]\` for passing items
- Take screenshots of failures
- Save API responses

### 4. Probe for failures (edge cases)

For each feature, test these categories as applicable:

**Input edge cases:** empty strings, null, whitespace-only, boundary values (0, -1, MAX_INT), very long strings, special characters (\`<script>\`, SQL injection strings), wrong types

**API edge cases:** missing required fields (omit one at a time), extra unexpected fields, wrong HTTP methods, malformed JSON, large payloads

**UI edge cases (if applicable):** double-click submission, navigation during submit, back button after submit, refresh during operations, empty states, loading states

**Error handling:** network failure, timeouts, 500 errors, 404s, validation error messages

**Security:** unauthenticated access to protected resources, cross-user data access, sensitive data in responses/logs

### 5. Update verification.md with final results

Mark all tested items: \`[x]\` for pass, \`[ ]\` for fail with notes explaining why.

### 6. Document findings in progress.txt

Complete the testing session entry. Be specific: what input caused what failure.

### 7. Output final signal

PRD_VERIFIED only if both happy path and edge cases pass.

</Investigation_Protocol>

<Output_Format>

These signals determine PRD state transitions:
- PRD_VERIFIED → PRD moves to completed
- PRD_FAILED → fix story created, PRD moves back to in_progress

Create a detailed report, then output your signal:

**If ALL tests pass:**
\`\`\`
<test-result>PRD_VERIFIED</test-result>
\`\`\`

**If ANY tests fail:**
\`\`\`
<test-result>PRD_FAILED</test-result>
<issues>
- Issue description 1
- Issue description 2
</issues>
\`\`\`

### Example report

\`\`\`markdown
# Test Report: ${prd.name}

## Project Quality Checks
- [x] Linting: PASS
- [x] Type checking: PASS
- [ ] Tests: FAIL - 2 tests failed in auth.test.ts

## Verification Results

### Passed
- [x] User can log in
- [x] Dashboard loads correctly

### Failed
- [ ] User profile shows wrong email - Screenshot: screenshots/issue-001.png

## Summary
- Total: 10
- Passed: 8
- Failed: 2
\`\`\`

</Output_Format>

<Circuit_Breaker>
If quality checks fail 3 times in a row, stop retrying and report PRD_FAILED with a summary of what's failing and why, rather than looping indefinitely.
</Circuit_Breaker>

<Failure_Modes_To_Avoid>
- **Happy-path-only testing** — verifying the feature "works" without probing edge cases misses the bugs users will hit
- **Untraceable results** — always update progress.txt and verification.md so the next developer (or fix agent) knows what was tested
- **Missing signal** — the orchestrator needs the \`<test-result>\` signal to proceed; omitting it requires manual intervention
</Failure_Modes_To_Avoid>

<Examples>

**Good test session:** Runs quality checks first, goes through verification checklist item by item, tries invalid inputs on each form field, tests API with missing fields, documents every test in progress.txt, screenshots failures, outputs clear signal with specific issue list.

**Bad test session:** Runs the app once, confirms it loads, outputs PRD_VERIFIED without testing edge cases or updating verification.md.

</Examples>
`;
}

/**
 * Detect test result signal from agent output
 */
export function detectTestResult(output: string): "verified" | "failed" | null {
	if (output.includes("<test-result>PRD_VERIFIED</test-result>")) {
		return "verified";
	}
	if (output.includes("<test-result>PRD_FAILED</test-result>")) {
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
 * Parse test results from agent output
 */
export function parseTestReport(output: string, prdName: string): TestReport {
	const results: TestResult[] = [];
	let passed = 0;
	let failed = 0;

	// Try to extract the test-report section or use full output
	const reportMatch = output.match(/<test-report>([\s\S]*?)<\/test-report>/);
	const reportContent: string = reportMatch?.[1] ?? output;

	// Parse passed items
	const passedMatches = reportContent.matchAll(/- \[x\]\s*(.+?)(?:\n|$)/gi);
	for (const match of passedMatches) {
		const item = match[1]?.trim();
		if (item) {
			results.push({ item, passed: true });
			passed++;
		}
	}

	// Parse failed items
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
		testResults: results,
		summary: {
			total: passed + failed,
			passed,
			failed,
		},
		agentOutput: output,
	};
}

/**
 * Save test report to file
 */
export async function saveTestReport(
	projectName: string,
	repoRoot: string,
	prdName: string,
	report: TestReport,
): Promise<string> {
	const testResultsDir = getTestResultsDir(projectName, repoRoot, prdName);
	if (!testResultsDir) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	const reportPath = join(testResultsDir, "report.md");

	// Format as markdown
	const lines: string[] = [];
	lines.push(`# Test Report: ${prdName}`);
	lines.push("");
	lines.push(`**Tested:** ${report.timestamp}`);
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push(`- **Total:** ${report.summary.total}`);
	lines.push(`- **Passed:** ${report.summary.passed}`);
	lines.push(`- **Failed:** ${report.summary.failed}`);
	lines.push("");

	if (report.testResults.length > 0) {
		const passedResults = report.testResults.filter((r) => r.passed);
		const failedResults = report.testResults.filter((r) => !r.passed);

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
 * Read previous test report and extract failed items
 */
export async function getPreviousFailures(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string[] | null> {
	const testResultsDir = getTestResultsDir(projectName, repoRoot, prdName);
	if (!testResultsDir) return null;

	const reportPath = join(testResultsDir, "report.md");
	if (!existsSync(reportPath)) return null;

	try {
		const content = await readFile(reportPath, "utf-8");

		// Extract failed items from the report
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

		// Also extract issues from the report
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
 * Generate a focused retest prompt for previously failed items
 */
export async function generateRetestPrompt(
	projectName: string,
	repoRoot: string,
	prdName: string,
	previousFailures: string[],
	config: RalphConfig,
): Promise<string> {
	const status = findPRDLocation(projectName, repoRoot, prdName);
	const prdDir = status ? `${getStatusDir(projectName, repoRoot, status)}/${prdName}` : "(unknown)";
	const testResultsDir = getTestResultsDir(projectName, repoRoot, prdName) || "test-results";

	// Get project verification instructions from config
	const projectInstructions =
		config.testing?.project_verification_instructions ||
		"Run project quality checks (lint, typecheck, tests) to ensure code quality.";

	// Testing instructions (URLs, credentials, context)
	const testingInstructions = config.testing?.instructions || "";

	return `<Role>
Retest agent. Verify that previously failed tests have been fixed.
</Role>

<Scope>
This is a focused retest, not a full test run. Verify only the ${previousFailures.length} item(s) that previously failed. Re-running the entire suite wastes time on items that already passed.
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

${testingInstructions ? `**Testing instructions:** ${testingInstructions}\n` : ""}

**Test results directory:** \`${testResultsDir}/\`

</Investigation_Protocol>

<Output_Format>

These signals determine PRD state transitions. The orchestrator parses them to decide whether to complete or loop back for fixes.

**If ALL previously failed items are now fixed:**
\`\`\`
<test-result>PRD_VERIFIED</test-result>
\`\`\`

**If ANY items still fail:**
\`\`\`
<test-result>PRD_FAILED</test-result>
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
- Test Results: ${prdDir}/test-results/
</File_Paths>
`;
}
