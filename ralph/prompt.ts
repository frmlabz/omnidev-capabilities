/**
 * Ralph Prompt Generator
 *
 * Generates agent prompts from PRD context for orchestration.
 */

import { getProgress, getSpec } from "./state.ts";
import type { PRD, Story } from "./types.d.ts";

/**
 * Extract codebase patterns from progress content
 */
function extractPatterns(progressContent: string): string[] {
	const lines = progressContent.split("\n");
	const patterns: string[] = [];
	let inPatternsSection = false;

	for (const line of lines) {
		if (line.startsWith("## Codebase Patterns")) {
			inPatternsSection = true;
			continue;
		}
		if (line.startsWith("## ") && inPatternsSection) {
			break;
		}
		if (inPatternsSection && line.startsWith("- ")) {
			patterns.push(line.slice(2));
		}
	}

	return patterns;
}

/**
 * Generates a prompt for the agent based on PRD and current story.
 */
export async function generatePrompt(prd: PRD, story: Story, prdName: string): Promise<string> {
	// Load progress and spec
	const progressContent = await getProgress(prdName);
	let specContent = "";
	try {
		specContent = await getSpec(prdName);
	} catch {
		specContent = "(spec.md not found)";
	}

	const patterns = extractPatterns(progressContent);

	// Format acceptance criteria
	const criteriaLines = story.acceptanceCriteria.map((c) => `  - ${c}`).join("\n");

	// Format patterns
	const patternsText = patterns.length > 0 ? patterns.map((p) => `- ${p}`).join("\n") : "None yet";

	// Get last 20 lines of progress for summary
	const progressLines = progressContent.split("\n");
	const recentProgress = progressLines.slice(-20).join("\n");

	// Format other stories for context
	const otherStories = prd.stories
		.filter((s) => s.id !== story.id)
		.map((s) => `  - ${s.id}: ${s.title} [${s.status}]`)
		.join("\n");

	return `# Ralph Agent Instructions

You are an autonomous coding agent working on the ${prd.name} feature.

## Feature Overview

${prd.description}

## Your Current Task

**${story.id}: ${story.title}**

Acceptance Criteria:
${criteriaLines}

## Workflow

1. **Read the spec** at \`.omni/state/ralph/prds/${prdName}/spec.md\` for full requirements
2. **Read the progress log** at \`.omni/state/ralph/prds/${prdName}/progress.txt\` (check Codebase Patterns first)
3. **Implement this story** following the spec and acceptance criteria
4. **Run quality checks**: \`bun run check\` (typecheck + lint + format:check)
5. **Run tests**: \`bun test\`
6. **Commit changes**: \`git commit -m "feat: [${story.id}] - ${story.title}"\`
7. **Update prd.json**: Set this story's status to "completed"
8. **Append to progress.txt**: Document what you did

**Note:** Work on the current branch. Do not create or switch branches.

## Spec File

\`\`\`markdown
${specContent.slice(0, 3000)}${specContent.length > 3000 ? "\n...(truncated)" : ""}
\`\`\`

## Progress Report Format

APPEND to progress.txt (never replace):

\`\`\`markdown
## [Date/Time] - ${story.id}: ${story.title}

**What was done:**
- Implementation details

**Files changed:**
- file1.ts
- file2.ts

**Patterns discovered:**
- Any reusable patterns

---
\`\`\`

## If You're Blocked

If you cannot complete this story (unclear requirements, missing dependencies, etc.):

1. Update prd.json: Set this story's status to "blocked"
2. Add questions to the story's \`questions\` array
3. End your response explaining why

Example:
\`\`\`json
{
  "id": "${story.id}",
  "status": "blocked",
  "questions": [
    "Should X return Y or Z?",
    "What is the expected behavior for edge case W?"
  ]
}
\`\`\`

## Running Commands

\`\`\`bash
bun run check         # TypeScript + lint + format check
bun test              # Run tests
bun run format        # Fix formatting
bun run lint:fix      # Fix lint issues
\`\`\`

## Technology Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript (strict mode)
- **Packages**: ESM only
- **Linting**: Biome
- **Testing**: Bun's built-in test runner

## Stop Condition

After completing this story, check if ALL stories have \`status: "completed"\`.

If ALL stories are complete, reply with:
<promise>COMPLETE</promise>

Otherwise, end your response normally.

## Important

- Work on ONE story per iteration
- Keep quality checks green
- Commit with message: \`feat: [${story.id}] - ${story.title}\`
- Do NOT use type escape hatches (\`any\`, \`as unknown\`)
- If blocked, use the questions array - don't guess

## Other Stories in This PRD

${otherStories || "  (none)"}

## Recent Progress

${recentProgress || "(no progress yet)"}

## Codebase Patterns

${patternsText}
`;
}
