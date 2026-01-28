/**
 * Ralph Testing Orchestration
 *
 * Handles test execution for PRDs with Playwriter integration and QA feedback loop.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadRalphConfig, runAgent } from "./orchestrator.ts";
import {
	addFixStory,
	clearTestResults,
	extractAndSaveFindings,
	findPRDLocation,
	getTestResultsDir,
	getPRD,
	getProgress,
	getSpec,
	movePRD,
} from "./state.ts";
import type { RalphConfig, TestReport, TestResult } from "./types.d.ts";
import { getVerification, hasVerification } from "./verification.ts";

/**
 * Run a script from a configured path
 * @param scriptPath - Path to the script (from config), or undefined if not configured
 * @param scriptName - Friendly name for logging (e.g., "setup", "teardown")
 * @param prdName - Optional PRD name passed as first argument to script
 */
async function runScript(
	scriptPath: string | undefined,
	scriptName: string,
	prdName?: string,
): Promise<{ success: boolean; output: string }> {
	if (!scriptPath) {
		return { success: true, output: `${scriptName} script not configured, skipping` };
	}

	const fullPath = join(process.cwd(), scriptPath);

	if (!existsSync(fullPath)) {
		return { success: true, output: `${scriptName} script not found at ${scriptPath}, skipping` };
	}

	return new Promise((resolve) => {
		const args = prdName ? [fullPath, prdName] : [fullPath];
		const proc = spawn("bash", args, {
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({
				success: code === 0,
				output: stdout + stderr,
			});
		});

		proc.on("error", (error) => {
			resolve({
				success: false,
				output: error.message,
			});
		});
	});
}

/**
 * Run health check with polling until ready or timeout
 * @param healthCheckPath - Path to health check script from config
 * @param timeoutSeconds - Timeout in seconds
 */
async function waitForHealthCheck(
	healthCheckPath: string | undefined,
	timeoutSeconds: number,
): Promise<boolean> {
	if (!healthCheckPath) {
		console.log("No health check script configured, skipping health check");
		return true;
	}

	const fullPath = join(process.cwd(), healthCheckPath);

	if (!existsSync(fullPath)) {
		console.log(`Health check script not found at ${healthCheckPath}, skipping health check`);
		return true;
	}

	const startTime = Date.now();
	const timeoutMs = timeoutSeconds * 1000;
	const pollIntervalMs = 2000;

	console.log(`Waiting for health check (timeout: ${timeoutSeconds}s)...`);

	while (Date.now() - startTime < timeoutMs) {
		const { success } = await runScript(healthCheckPath, "health_check");
		if (success) {
			console.log("Health check passed!");
			return true;
		}

		const elapsed = Math.round((Date.now() - startTime) / 1000);
		process.stdout.write(`\rHealth check pending... ${elapsed}s / ${timeoutSeconds}s`);

		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	console.log("\nHealth check timed out!");
	return false;
}

/**
 * Playwriter instructions for web testing
 */
function getPlaywriterInstructions(): string {
	return `
## Web Testing with Playwriter MCP

You have access to the Playwriter MCP for browser automation. Use it to test web UI.

### Session Setup (REQUIRED FIRST STEP)

Before any web testing, create a session and your own page:

\`\`\`bash
# Create a new session (outputs session id, e.g., 1)
playwriter session new

# IMPORTANT: Create your own page to avoid interference from other agents
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

# Screenshot on failure (ALWAYS do this when something fails)
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

### Important Notes

- ALWAYS use \`state.myPage\` instead of \`page\` to avoid conflicts
- Take screenshots of ANY issues you find
- Save API responses to test-results/api-responses/
- Clean up: \`playwriter -s 1 -e "await state.myPage.close()"\` when done
`;
}

/**
 * Generate the test prompt for the agent
 */
export async function generateTestPrompt(prdName: string, config: RalphConfig): Promise<string> {
	const prd = await getPRD(prdName);
	const status = findPRDLocation(prdName);

	// Load all context files
	let specContent = "";
	try {
		specContent = await getSpec(prdName);
	} catch {
		specContent = "(spec.md not found)";
	}

	let verificationContent = "";
	try {
		verificationContent = await getVerification(prdName);
	} catch {
		verificationContent =
			"(verification.md not found - generate it first with 'omnidev ralph verify')";
	}

	let progressContent = "";
	try {
		progressContent = await getProgress(prdName);
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
	const testResultsDir = getTestResultsDir(prdName) || "test-results";

	return `# Testing Task: ${prd.name}

You are a senior QA engineer. Your job is not just to verify the feature works - it's to **try to break it**.

Think like an adversary. Find edge cases, test boundaries, try unexpected inputs, and verify error handling. A feature that "works" but crashes on edge cases is not ready for production.

## Your QA Mindset

1. **Don't just test the happy path** - Test what happens when things go wrong
2. **Try to break it** - Invalid inputs, empty values, special characters, huge data
3. **Check error handling** - Are errors graceful? Do they expose sensitive info?
4. **Verify edge cases** - Boundaries, limits, concurrent access, race conditions
5. **Think like a malicious user** - What if someone intentionally misuses this?

## CRITICAL: Test Result Signals

At the end of your testing, you MUST output one of these signals:

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

These signals determine what happens next:
- PRD_VERIFIED → PRD moves to completed automatically
- PRD_FAILED → Fix story created, PRD moves back to pending

## Project Verification Instructions

**IMPORTANT:** ${projectInstructions}

Run these checks FIRST before any other testing.

${
	testingInstructions
		? `## Testing Instructions

${testingInstructions}
`
		: ""
}
## Test Results Directory

Save all evidence to: \`${testResultsDir}/\`
- Screenshots: \`${testResultsDir}/screenshots/\`
- API responses: \`${testResultsDir}/api-responses/\`

${playwriterSection}

## API Testing

Test API endpoints directly with curl:

\`\`\`bash
# GET request
curl -s http://localhost:3000/api/endpoint | tee ${testResultsDir}/api-responses/endpoint-get.json

# POST request
curl -s -X POST -H "Content-Type: application/json" -d '{"key":"value"}' http://localhost:3000/api/endpoint | tee ${testResultsDir}/api-responses/endpoint-post.json
\`\`\`

## QA Testing Patterns - TRY TO BREAK IT

### Input Validation (try these for ALL user inputs)
- **Empty values**: \`""\`, \`null\`, \`undefined\`, whitespace only \`"   "\`
- **Boundary values**: 0, -1, MAX_INT, very long strings (10000+ chars)
- **Special characters**: \`<script>alert('xss')</script>\`, \`'; DROP TABLE users;--\`
- **Unicode/emoji**: \`日本語\`, \`🎉\`, \`\u0000\` (null byte)
- **Wrong types**: string where number expected, array where object expected

### API Edge Cases
- **Missing required fields**: Omit each required field one at a time
- **Extra fields**: Send unexpected fields - are they ignored or cause errors?
- **Wrong HTTP methods**: GET when POST expected, etc.
- **Invalid JSON**: Malformed JSON body
- **Large payloads**: Very large request bodies
- **Rate limiting**: Rapid repeated requests
- **Auth edge cases**: Expired tokens, invalid tokens, missing auth

### UI/Form Testing
- **Double submission**: Click submit twice rapidly
- **Navigation during submit**: Navigate away while form is submitting
- **Back button**: Submit, go back, submit again - duplicate data?
- **Refresh**: Refresh page during/after operations
- **Empty states**: What shows when there's no data?
- **Loading states**: Is there feedback during async operations?
- **Error display**: Are error messages helpful and non-technical?

### State & Data
- **Concurrent access**: Same resource modified by two users
- **Stale data**: What if data changed since page load?
- **Cache issues**: Does old data persist incorrectly?
- **Pagination boundaries**: First page, last page, page beyond data
- **Sort edge cases**: Sort with ties, sort empty list
- **Filter edge cases**: Filter that matches nothing, filter with special chars

### Error Handling Verification
- **Network failure**: What happens if API call fails?
- **Timeout**: What happens on slow response?
- **500 errors**: Does the app handle server errors gracefully?
- **404 errors**: Missing resources handled properly?
- **Validation errors**: Are they specific and actionable?

### Security Considerations
- **Auth required**: Can unauthenticated users access protected resources?
- **Authorization**: Can user A access user B's data?
- **Sensitive data exposure**: Are passwords, tokens, PII exposed in responses/logs?
- **Error messages**: Do errors reveal system internals?

## PRD (Product Requirements Document)

\`\`\`json
${prdJson.slice(0, 3000)}${prdJson.length > 3000 ? "\n...(truncated)" : ""}
\`\`\`

## Specification

\`\`\`markdown
${specContent.slice(0, 5000)}${specContent.length > 5000 ? "\n...(truncated)" : ""}
\`\`\`

## Verification Checklist

This is what you need to verify:

\`\`\`markdown
${verificationContent}
\`\`\`

## Progress Log (Implementation Details)

\`\`\`
${progressContent.slice(0, 5000)}${progressContent.length > 5000 ? "\n...(truncated)" : ""}
\`\`\`

## Testing Process

1. **Start a testing session in progress.txt**

   Append a new testing session entry to progress.txt:
   \`\`\`markdown
   ---

   ## [Testing Session] ${new Date().toISOString().split("T")[0]}

   **Quality Checks:**
   (lint, typecheck, tests results)

   **Verification Checklist:**
   (update as you test each item)

   **Edge Case Testing:**
   (document what you tried to break and results)

   **Issues Found:**
   (document any failures here)

   ---
   \`\`\`

2. **Run project quality checks first**
   - Lint, typecheck, tests, formatting
   - Update progress.txt with results
   - If any fail, document and report PRD_FAILED

3. **Go through verification checklist (happy path)**
   - Test each item systematically
   - **Update verification.md** - change \`[ ]\` to \`[x]\` for passing items
   - Take screenshots of failures
   - Save API responses

4. **TRY TO BREAK IT (edge cases)**
   - For each feature, apply the QA Testing Patterns above
   - Try invalid inputs, empty values, special characters
   - Test error handling and edge cases
   - Document everything you try in progress.txt
   - Screenshot any crashes or unexpected behavior

5. **For web testing (if applicable)**
   - Create Playwriter session
   - Use state.myPage for isolation
   - Test the happy path first
   - Then try to break the UI: double-clicks, rapid navigation, back button, refresh

6. **Update verification.md with final results**
   - Mark all tested items: \`[x]\` for pass, \`[ ]\` for fail
   - Add notes next to failed items explaining why
   - Add any new edge case issues you discovered

7. **Document findings in progress.txt**
   - Complete the testing session entry
   - List ALL issues found (including edge cases)
   - Be specific: what input caused what failure

8. **Output final signal**
   - PRD_VERIFIED only if BOTH happy path AND edge cases pass
   - PRD_FAILED with issues list if anything is broken

## Output Format

Create a detailed report, then output your signal:

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

Then:

\`\`\`
<test-result>PRD_FAILED</test-result>
<issues>
- Tests failing in auth.test.ts
- User profile shows wrong email
</issues>
\`\`\`

## File Paths

PRD files are located at:
- PRD: .omni/state/ralph/prds/${status}/${prdName}/prd.json
- Spec: .omni/state/ralph/prds/${status}/${prdName}/spec.md
- Progress: .omni/state/ralph/prds/${status}/${prdName}/progress.txt (append testing session here)
- Verification: .omni/state/ralph/prds/${status}/${prdName}/verification.md (update checkboxes here)
- Test Results: .omni/state/ralph/prds/${status}/${prdName}/test-results/

## Important

- **Always update progress.txt** with your testing session - this creates a history
- **Always update verification.md** to reflect actual test results - mark items [x] or [ ]
- The next developer (or fix story agent) will read these to understand what was tested

Begin testing now. Be thorough and always output your final signal.
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
export async function saveTestReport(prdName: string, report: TestReport): Promise<string> {
	const testResultsDir = getTestResultsDir(prdName);
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
async function getPreviousFailures(prdName: string): Promise<string[] | null> {
	const testResultsDir = getTestResultsDir(prdName);
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
async function generateRetestPrompt(
	prdName: string,
	previousFailures: string[],
	config: RalphConfig,
): Promise<string> {
	const prd = await getPRD(prdName);
	const status = findPRDLocation(prdName);
	const testResultsDir = getTestResultsDir(prdName) || "test-results";

	// Get project verification instructions from config
	const projectInstructions =
		config.testing?.project_verification_instructions ||
		"Run project quality checks (lint, typecheck, tests) to ensure code quality.";

	// Testing instructions (URLs, credentials, context)
	const testingInstructions = config.testing?.instructions || "";

	return `# Retest Task: ${prd.name}

You are verifying that previously failed tests have been fixed.

## CRITICAL: This is a FOCUSED RETEST

A previous test run found failures. Your job is to verify ONLY the items that previously failed.
Do NOT re-run the entire test suite - focus on the specific failures listed below.

## Previous Failures to Verify

${previousFailures.map((f, i) => `${i + 1}. ${f}`).join("\n")}

## Project Verification Instructions

${projectInstructions}

${testingInstructions ? `## Testing Instructions\n\n${testingInstructions}\n` : ""}

## Test Results Directory

Save evidence to: \`${testResultsDir}/\`

## Your Task

1. For each previously failed item above:
   - Verify if it has been fixed
   - Document the result (pass/fail)
   - If still failing, explain why

2. Run project quality checks (lint, typecheck, tests) to ensure fixes didn't break anything

3. Output your result:

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

## File Paths

PRD files are located at:
- PRD: .omni/state/ralph/prds/${status}/${prdName}/prd.json
- Progress: .omni/state/ralph/prds/${status}/${prdName}/progress.txt
- Verification: .omni/state/ralph/prds/${status}/${prdName}/verification.md
- Test Results: .omni/state/ralph/prds/${status}/${prdName}/test-results/

Begin focused retest now. Only verify the ${previousFailures.length} previously failed item(s).
`;
}

/**
 * Run testing for a PRD with QA feedback loop
 */
export async function runTesting(
	prdName: string,
	agentOverride?: string,
): Promise<{ report: TestReport; result: "verified" | "failed" | "unknown" }> {
	const config = await loadRalphConfig();

	const agentName = agentOverride ?? config.default_agent;

	// Validate agent exists
	const agentConfig = config.agents[agentName];
	if (!agentConfig) {
		throw new Error(
			`Agent '${agentName}' not found in config. Available: ${Object.keys(config.agents).join(", ")}`,
		);
	}

	// Check PRD exists
	const status = findPRDLocation(prdName);
	if (!status) {
		throw new Error(`PRD not found: ${prdName}`);
	}

	// Warn if not in testing status
	if (status !== "testing") {
		console.log(`\n⚠️  PRD "${prdName}" is in ${status} status (not testing).`);
		console.log("Testing is typically done after all stories are complete.\n");
	}

	// Check for verification.md
	if (!hasVerification(prdName)) {
		console.log(`\n⚠️  No verification.md found for "${prdName}".`);
		console.log("Generating verification checklist first...\n");

		const { generateVerification, generateSimpleVerification } = await import("./verification.js");

		try {
			await generateVerification(prdName, agentConfig, runAgent);
			console.log("Verification checklist generated.\n");
		} catch {
			console.log("Failed to generate with LLM, using simple generator...\n");
			await generateSimpleVerification(prdName);
		}
	}

	// Check for previous test failures (for focused retesting)
	const previousFailures = await getPreviousFailures(prdName);
	const isFocusedRetest = previousFailures !== null && previousFailures.length > 0;

	if (isFocusedRetest) {
		console.log(
			`\n🔄 Found ${previousFailures.length} previous failure(s) - running focused retest`,
		);
		console.log("Previous failures:");
		for (const failure of previousFailures) {
			console.log(`  - ${failure}`);
		}
		console.log("");
	} else {
		// Clear previous test results only for full test runs
		console.log("Clearing previous test results...");
		await clearTestResults(prdName);
	}

	console.log(`\nStarting ${isFocusedRetest ? "focused retest" : "testing"} for PRD: ${prdName}`);
	console.log(`Using agent: ${agentName}`);
	if (config.testing?.web_testing_enabled) {
		console.log("Web testing: enabled");
	}
	console.log("");

	// Get script paths from config
	const scripts = config.scripts;

	// Run teardown first to ensure clean state
	console.log("Running teardown script (ensuring clean state)...");
	const preTeardownResult = await runScript(scripts?.teardown, "teardown", prdName);
	if (preTeardownResult.output && !preTeardownResult.output.includes("not configured")) {
		console.log(preTeardownResult.output);
	}

	// Run setup script
	console.log("Running setup script...");
	const setupResult = await runScript(scripts?.setup, "setup", prdName);
	if (!setupResult.success) {
		console.log(`Setup script failed: ${setupResult.output}`);
		// Continue anyway - setup might be optional
	} else {
		console.log(setupResult.output);
	}

	// Run start script
	console.log("Running start script...");
	const startResult = await runScript(scripts?.start, "start", prdName);
	if (!startResult.success) {
		console.log(`Start script failed or not configured: ${startResult.output}`);
		// Continue anyway - might not need server start
	} else {
		console.log(startResult.output);
	}

	// Wait for health check
	const healthCheckTimeout = config.testing?.health_check_timeout ?? 120;
	const healthCheckPassed = await waitForHealthCheck(scripts?.health_check, healthCheckTimeout);
	if (!healthCheckPassed) {
		console.log("\n⚠️  Health check failed - continuing anyway, tests may fail");
	}

	// Generate test prompt (focused or full)
	const prompt = isFocusedRetest
		? await generateRetestPrompt(prdName, previousFailures, config)
		: await generateTestPrompt(prdName, config);

	// Run agent with streaming output
	console.log("\nSpawning test agent...\n");
	const { output, exitCode } = await runAgent(prompt, agentConfig, { stream: true });

	// Log exit code (output already streamed)
	console.log(`\n--- Exit Code: ${exitCode} ---\n`);

	// Parse results
	const report = parseTestReport(output, prdName);

	// Detect test result signal
	const testResult = detectTestResult(output);
	const issues = extractIssues(output);

	// Save report
	console.log("Saving test report...");
	const reportPath = await saveTestReport(prdName, report);

	// Helper to run teardown
	const runTeardown = async () => {
		console.log("\nRunning teardown script...");
		const teardownResult = await runScript(scripts?.teardown, "teardown", prdName);
		if (teardownResult.output && !teardownResult.output.includes("not configured")) {
			console.log(teardownResult.output);
		}
	};

	// Handle result
	if (testResult === "verified") {
		console.log("\n✅ PRD_VERIFIED signal detected!");
		console.log("All tests passed. Moving PRD to completed...\n");

		// Extract findings
		console.log("Extracting findings...");
		await extractAndSaveFindings(prdName);

		// Move to completed
		await movePRD(prdName, "completed");

		await runTeardown();

		console.log(`\n🎉 PRD "${prdName}" has been completed!`);
		console.log(`Findings saved to .omni/state/ralph/findings.md`);
		console.log(`Test report: ${reportPath}`);

		return { report, result: "verified" };
	}

	if (testResult === "failed") {
		console.log("\n❌ PRD_FAILED signal detected!");
		console.log(`Issues found: ${issues.length}`);

		for (const issue of issues) {
			console.log(`  - ${issue}`);
		}

		// Create fix story
		console.log("\nCreating fix story...");
		const testResultsRelPath = `test-results/report.md`;
		const fixStoryId = await addFixStory(prdName, issues, testResultsRelPath);

		// Move back to pending
		console.log("Moving PRD back to pending...");
		await movePRD(prdName, "pending");

		await runTeardown();

		console.log(`\n📋 Fix story created: ${fixStoryId}`);
		console.log(`PRD "${prdName}" moved back to pending.`);
		console.log(
			`\nTo view issues: cat .omni/state/ralph/prds/pending/${prdName}/test-results/report.md`,
		);
		console.log(`To fix issues: omnidev ralph start ${prdName}`);

		return { report, result: "failed" };
	}

	// No clear signal detected
	await runTeardown();

	console.log("\n⚠️  No clear test result signal detected.");
	console.log(
		"Agent should output <test-result>PRD_VERIFIED</test-result> or <test-result>PRD_FAILED</test-result>",
	);
	console.log(`\nTest report saved to: ${reportPath}`);
	console.log("\nManual action required:");
	console.log(`  omnidev ralph complete ${prdName}    # if tests passed`);
	console.log(`  omnidev ralph prd ${prdName} --move pending  # if issues found`);

	return { report, result: "unknown" };
}
