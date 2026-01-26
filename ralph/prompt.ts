/**
 * Ralph Prompt Generator
 *
 * Generates agent prompts from PRD context for orchestration.
 */

import { getProgress, getPRD, getSpec } from "./state.ts";
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

	// Format previous questions/answers if story was unblocked
	let questionsAnswersText = "";
	if (story.answers && story.answers.length > 0) {
		questionsAnswersText = "\n\n**Previous Questions & User Answers:**\n";
		for (let i = 0; i < story.questions.length; i++) {
			const question = story.questions[i];
			const answer = story.answers[i];
			questionsAnswersText += `  Q${i + 1}: ${question}\n`;
			questionsAnswersText += `  A${i + 1}: ${answer}\n\n`;
		}
	}

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

You are an autonomous coding agent working on a Ralph-managed PRD. Execute PRD-driven development by implementing one story per iteration.

## Feature Overview

**${prd.name}**: ${prd.description}

## Your Current Task

**${story.id}: ${story.title}**

Acceptance Criteria:
${criteriaLines}${questionsAnswersText}

## Workflow

### 1. Read Context

**Check the PRD and progress first:**

\`\`\`bash
# Read the PRD to understand the feature
cat .omni/state/ralph/prds/${prdName}/prd.json

# Read the spec for detailed requirements
cat .omni/state/ralph/prds/${prdName}/spec.md

# Read progress log to understand patterns and recent work
cat .omni/state/ralph/prds/${prdName}/progress.txt
\`\`\`

**Important:**
- The **spec.md** contains the feature requirements
- The **progress.txt** contains patterns discovered in previous iterations
- The **lastRun** field in prd.json shows where the previous run stopped

### 2. Pick Next Story

Look at \`prd.json\` and find the next story to work on:

1. Find stories with \`status: "in_progress"\` first (resume interrupted work)
2. Otherwise, find the lowest \`priority\` story with \`status: "pending"\`
3. Skip stories with \`status: "blocked"\` (waiting for user input)

### 3. Implement the Story

Follow the spec requirements and the story's acceptance criteria:

- Implement ONLY what's needed for this story
- Follow patterns from progress.txt
- Keep changes focused and minimal

### 4. Run Quality Checks

Before committing, ensure all checks pass:

\`\`\`bash
npm run check      # Runs typecheck + lint + format:check
npm test           # Run tests
\`\`\`

Fix any issues before proceeding.

### 5. Commit Changes

When all checks pass:

\`\`\`bash
git add .
git commit -m "feat: [${story.id}] - ${story.title}"
\`\`\`

### 6. Update PRD

Mark the story as completed in prd.json:

\`\`\`json
{
  "id": "${story.id}",
  "status": "completed"
}
\`\`\`

Save the updated PRD.

### 7. Append Progress

Add an entry to progress.txt:

\`\`\`markdown
## [Date/Time] - ${story.id}: ${story.title}

**What was done:**
- Brief description of implementation

**Files changed:**
- file1.ts
- file2.ts

**Patterns discovered:**
- Pattern or approach that worked well

---
\`\`\`

### 8. Check for Completion

After updating the PRD, check if ALL stories have \`status: "completed"\`.

If ALL stories are complete, reply with:
\`\`\`
<promise>COMPLETE</promise>
\`\`\`

Otherwise, end your response normally. Ralph will spawn the next iteration.

## Spec File

\`\`\`markdown
${specContent.slice(0, 3000)}${specContent.length > 3000 ? "\n...(truncated)" : ""}
\`\`\`

## Handling Blocked Stories

If you cannot complete a story (unclear requirements, missing dependencies, etc.):

1. Set \`status: "blocked"\` in the story
2. Add your questions to the \`questions\` array:

\`\`\`json
{
  "id": "${story.id}",
  "status": "blocked",
  "questions": [
    "Should the API return 404 or empty array when no results?",
    "What is the maximum page size for pagination?"
  ]
}
\`\`\`

3. Reply with a summary explaining why you're blocked

Ralph will stop and present the questions to the user.

## Running Commands

\`\`\`bash
npm run check         # TypeScript + lint + format check
npm test              # Run tests
npm run format        # Fix formatting
npm run lint          # Fix lint issues
\`\`\`

## Key Principles

- **One story per iteration** - Never implement multiple stories at once
- **Read the spec first** - The story title is just a summary
- **Keep checks green** - Never commit failing tests or lint errors
- **Document patterns** - Help future iterations by updating progress.txt
- **Ask when blocked** - Use the questions array, don't guess
- **Do NOT use type escape hatches** (\`any\`, \`as unknown\`)

## Stop Condition

After completing this story, check if ALL stories have \`status: "completed"\`.

If ALL stories are complete, reply with:
<promise>COMPLETE</promise>

Otherwise, end your response normally.

**Note:** PRDs work on the current branch. The user manages branches/worktrees externally.

## Other Stories in This PRD

${otherStories || "  (none)"}

## Recent Progress

${recentProgress || "(no progress yet)"}

## Codebase Patterns

${patternsText}
`;
}

/**
 * Generates a prompt for extracting findings from a completed PRD.
 */
export async function generateFindingsExtractionPrompt(prdName: string): Promise<string> {
	const prd = await getPRD(prdName);
	const progressContent = await getProgress(prdName);
	let specContent = "";
	try {
		specContent = await getSpec(prdName);
	} catch {
		specContent = "(spec.md not found)";
	}

	// Count completed stories
	const completedStories = prd.stories.filter((s) => s.status === "completed").length;
	const totalStories = prd.stories.length;

	return `# Findings Extraction Task

You are extracting learnings and patterns from a completed PRD for future reference.

## PRD Information

**Name:** ${prd.name}
**Description:** ${prd.description}
**Created:** ${prd.createdAt}
**Completed:** ${prd.completedAt ?? "N/A"}
**Stories:** ${completedStories}/${totalStories} completed

## Spec (Feature Requirements)

\`\`\`markdown
${specContent.slice(0, 5000)}${specContent.length > 5000 ? "\n...(truncated)" : ""}
\`\`\`

## Progress Log

\`\`\`
${progressContent.slice(0, 10000)}${progressContent.length > 10000 ? "\n...(truncated)" : ""}
\`\`\`

## Your Task

Analyze the progress log and extract valuable patterns and learnings. Focus on:

1. **Database Patterns:**
   - Query structures and joins
   - Table relationships discovered
   - Indexing decisions

2. **API Patterns:**
   - Endpoint structures
   - Response formats
   - Error handling approaches

3. **Code Patterns:**
   - File organization conventions
   - Naming conventions used
   - Testing approaches

4. **Business Logic Patterns:**
   - Validation rules discovered
   - State transitions
   - Edge case handling

5. **Learnings:**
   - What worked well
   - Gotchas and pitfalls encountered
   - Recommendations for similar future work

## Output Format

Output ONLY a markdown section that can be appended to a findings file. Use this exact format:

\`\`\`markdown
## [DATE] ${prd.name}

**Description:** ${prd.description}

**Stories Completed:** ${completedStories}

### Patterns Discovered

- Pattern 1: Description
- Pattern 2: Description
- ...

### Key Learnings

- Learning 1: Description
- Learning 2: Description
- ...

### Code Examples (if any notable patterns)

\`\`\`language
// Example code if relevant
\`\`\`

---
\`\`\`

Replace [DATE] with today's date in YYYY-MM-DD format.

Be concise but specific. Focus on actionable patterns that would help someone working on similar features in this codebase.
`;
}
