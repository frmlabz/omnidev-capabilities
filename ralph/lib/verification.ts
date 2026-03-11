/**
 * Ralph Verification Generator
 *
 * Generates verification.md files from PRD context for testing.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findPRDLocation, getPRD, getProgress, getSpec } from "./state.js";
import type { AgentConfig } from "./types.js";
import { getStatusDir, atomicWrite } from "./core/paths.js";

const DEFAULT_DOCS_GLOB = "docs/**/*.md";

/**
 * Get the path to the verification file
 */
export function getVerificationPath(
	projectName: string,
	repoRoot: string,
	prdName: string,
): string | null {
	const status = findPRDLocation(projectName, repoRoot, prdName);
	if (!status) return null;
	return join(getStatusDir(projectName, repoRoot, status), prdName, "verification.md");
}

/**
 * Get the verification file content
 */
export async function getVerification(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string> {
	const verificationPath = getVerificationPath(projectName, repoRoot, prdName);

	if (!verificationPath || !existsSync(verificationPath)) {
		throw new Error(`Verification file not found for PRD: ${prdName}`);
	}

	return await readFile(verificationPath, "utf-8");
}

/**
 * Check if verification file exists
 */
export function hasVerification(projectName: string, repoRoot: string, prdName: string): boolean {
	const verificationPath = getVerificationPath(projectName, repoRoot, prdName);
	return verificationPath !== null && existsSync(verificationPath);
}

/**
 * Save verification content to file
 */
export async function saveVerification(
	projectName: string,
	repoRoot: string,
	prdName: string,
	content: string,
): Promise<void> {
	const verificationPath = getVerificationPath(projectName, repoRoot, prdName);
	if (!verificationPath) {
		throw new Error(`PRD not found: ${prdName}`);
	}
	await atomicWrite(verificationPath, content);
}

/**
 * Generate the prompt for verification generation
 */
export async function generateVerificationPrompt(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string> {
	const prd = await getPRD(projectName, repoRoot, prdName);
	const progressContent = await getProgress(projectName, repoRoot, prdName);
	let specContent = "";
	try {
		specContent = await getSpec(projectName, repoRoot, prdName);
	} catch {
		specContent = "(spec.md not found)";
	}

	// Format completed stories with their acceptance criteria
	const completedStories = prd.stories
		.filter((s) => s.status === "completed")
		.map((s) => {
			const criteria = s.acceptanceCriteria.map((c) => `    - ${c}`).join("\n");
			return `  - **${s.id}: ${s.title}**\n${criteria}`;
		})
		.join("\n\n");

	return `# Verification Checklist Generation

You are creating a verification checklist for a completed PRD. This checklist will be used by testers (human or AI) to verify that all features work correctly.

## PRD Information

**Name:** ${prd.name}
**Description:** ${prd.description}

## Specification

\`\`\`markdown
${specContent.slice(0, 8000)}${specContent.length > 8000 ? "\n...(truncated)" : ""}
\`\`\`

## Completed Stories

${completedStories || "(no completed stories)"}

## Progress Log (Implementation Details)

\`\`\`
${progressContent.slice(0, 8000)}${progressContent.length > 8000 ? "\n...(truncated)" : ""}
\`\`\`

## Your Task

Create a comprehensive verification checklist in markdown format. The checklist should:

1. **Be actionable** - Each item should be something a tester can verify
2. **Be specific** - Reference exact pages, APIs, or functionality
3. **Cover all acceptance criteria** - Every story's criteria should be testable
4. **Include edge cases** - Think about error states and boundary conditions
5. **Verify documentation** - Include checks for any required updates in ${DEFAULT_DOCS_GLOB}

## Output Format

Output ONLY the markdown content for verification.md. Use this exact structure:

\`\`\`markdown
# Verification Checklist: ${prd.name}

## Summary
[1-2 sentence summary of what this PRD introduced]

## Features Introduced
- [Feature 1]: [Brief description]
- [Feature 2]: [Brief description]

## API Verification
[If applicable - list API endpoints to test]
- [ ] \`METHOD /api/endpoint\` - [What to verify]
- [ ] \`METHOD /api/other\` - [What to verify]

## UI/Page Verification
[If applicable - list pages/routes to test]
- [ ] \`/page-route\` - [What should be visible/functional]
- [ ] \`/another-page\` - [Expected behavior]

## Functional Tests
[Core functionality to verify]
- [ ] [Test case 1] - [Expected result]
- [ ] [Test case 2] - [Expected result]

## Edge Cases & Error Handling
- [ ] [Edge case 1] - [Expected behavior]
- [ ] [Error scenario] - [Expected error message/handling]

## Documentation Verification
- [ ] Relevant files under \`${DEFAULT_DOCS_GLOB}\` were reviewed for this PRD
- [ ] Any changed behavior, API contract, config, command, or workflow was reflected in the affected docs
- [ ] No outdated documentation remains for the areas touched by this PRD

## Story-Specific Verification

### ${prd.stories[0]?.id || "US-001"}: [Story Title]
- [ ] [Acceptance criterion 1]
- [ ] [Acceptance criterion 2]

[Repeat for each story...]

## Notes for Testers
[Any special setup, test data, or considerations]
\`\`\`

Be concise but thorough. Focus on what needs to be verified, not how to verify it.
`;
}

/**
 * Generate verification.md for a PRD using an agent
 */
export async function generateVerification(
	projectName: string,
	repoRoot: string,
	prdName: string,
	agentConfig: AgentConfig,
	runAgentFn: (
		prompt: string,
		config: AgentConfig,
	) => Promise<{ output: string; exitCode: number }>,
): Promise<string> {
	const prompt = await generateVerificationPrompt(projectName, repoRoot, prdName);
	const { output, exitCode } = await runAgentFn(prompt, agentConfig);

	if (exitCode !== 0) {
		throw new Error(`Agent failed with exit code ${exitCode}`);
	}

	// Extract markdown content from output
	let verificationContent = output;

	// Try to find markdown content starting with "# Verification"
	const markdownMatch = output.match(/# Verification Checklist[\s\S]*/);
	if (markdownMatch) {
		verificationContent = markdownMatch[0];
	}

	// Save the verification file
	await saveVerification(projectName, repoRoot, prdName, verificationContent);

	return verificationContent;
}

/**
 * Generate a simple verification checklist without LLM (fallback)
 */
export async function generateSimpleVerification(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<string> {
	const prd = await getPRD(projectName, repoRoot, prdName);

	const lines: string[] = [];
	lines.push(`# Verification Checklist: ${prd.name}`);
	lines.push("");
	lines.push("## Summary");
	lines.push(prd.description);
	lines.push("");

	// Extract features from completed stories
	const completedStories = prd.stories.filter((s) => s.status === "completed");
	if (completedStories.length > 0) {
		lines.push("## Features Introduced");
		for (const story of completedStories) {
			lines.push(`- **${story.id}**: ${story.title}`);
		}
		lines.push("");
	}

	// Story-specific verification
	lines.push("## Story-Specific Verification");
	lines.push("");

	for (const story of completedStories) {
		lines.push(`### ${story.id}: ${story.title}`);
		for (const criterion of story.acceptanceCriteria) {
			lines.push(`- [ ] ${criterion}`);
		}
		lines.push("");
	}

	// Add code quality section
	lines.push("## Code Quality");
	lines.push("- [ ] All linting checks pass");
	lines.push("- [ ] All type checks pass");
	lines.push("- [ ] All tests pass");
	lines.push("- [ ] Code formatting is correct");
	lines.push("");

	lines.push("## Documentation Verification");
	lines.push(`- [ ] Relevant files under \`${DEFAULT_DOCS_GLOB}\` were reviewed`);
	lines.push("- [ ] Any required documentation updates were made");
	lines.push("- [ ] No outdated documentation remains for the changed behavior");
	lines.push("");

	lines.push("## Notes");
	lines.push("This is an auto-generated checklist. Review and expand as needed.");
	lines.push("");

	const content = lines.join("\n");
	await saveVerification(projectName, repoRoot, prdName, content);
	return content;
}
