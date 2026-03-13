/**
 * Ralph Prompt Generator
 *
 * Generates agent prompts from PRD context for orchestration.
 */

import { findPRDLocation, getProgress, getPRD, getSpec } from "./state.js";
import { getStatusDir } from "./core/paths.js";
import type { PRD, Story } from "./types.js";

const DEFAULT_DOCS_GLOB = "docs/**/*.md";

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
export async function generatePrompt(
	projectName: string,
	repoRoot: string,
	prd: PRD,
	story: Story,
	prdName: string,
): Promise<string> {
	const prdStatus = findPRDLocation(projectName, repoRoot, prdName) ?? "pending";
	const prdDir = `${getStatusDir(projectName, repoRoot, prdStatus)}/${prdName}`;

	// Load progress and spec
	const progressContent = await getProgress(projectName, repoRoot, prdName);
	let specContent = "";
	try {
		specContent = await getSpec(projectName, repoRoot, prdName);
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

	return `<Role>
Autonomous coding agent working on a Ralph-managed PRD. You implement one story per iteration, then signal completion.
</Role>

<Context>
**Feature:** ${prd.name} — ${prd.description}

**Spec file:**
\`\`\`markdown
${specContent.slice(0, 3000)}${specContent.length > 3000 ? "\n...(truncated)" : ""}
\`\`\`

**Other stories in this PRD:**
${otherStories || "  (none)"}

**Recent progress:**
${recentProgress || "(no progress yet)"}

**Codebase patterns:**
${patternsText}
</Context>

<Current_Task>
**${story.id}: ${story.title}**

Acceptance Criteria:
${criteriaLines}${questionsAnswersText}
</Current_Task>

<Workflow>

### 1. Read Context

Read these files before writing any code:

\`\`\`bash
cat ${prdDir}/prd.json
cat ${prdDir}/spec.md
cat ${prdDir}/progress.txt
rg --files docs -g '*.md'
\`\`\`

- **spec.md** has the feature requirements
- **progress.txt** has patterns discovered in previous iterations
- **lastRun** field in prd.json shows where the previous run stopped
- **${DEFAULT_DOCS_GLOB}** should be checked whenever behavior, APIs, UI, configuration, or workflows changed

### 2. Pick Next Story

1. Find stories with \`status: "in_progress"\` first (resume interrupted work)
2. Otherwise, find the lowest \`priority\` story with \`status: "pending"\`
3. Skip stories with \`status: "blocked"\` (waiting for user input)

### 3. Implement the Story

- Before writing new code, check how similar modules are structured in the codebase (export patterns, manifest files, config conventions) and follow the same pattern
- Implement only what's needed for this story
- Follow patterns from progress.txt
- Treat documentation as part of the deliverable, not post-hoc cleanup
- If this story changes user-facing behavior, developer workflows, configuration, or APIs, update the affected files under **${DEFAULT_DOCS_GLOB}**

### 4. Run Quality Checks

\`\`\`bash
npm run check      # Runs typecheck + lint + format:check
npm test           # Run tests
\`\`\`

Fix any issues before proceeding.

### 5. Check Documentation Impact

- Review the docs under **${DEFAULT_DOCS_GLOB}** before you mark the story done
- Update the relevant docs if the implementation changed behavior, config, commands, APIs, or workflows
- If no doc update is needed, confirm that explicitly in progress.txt with a short reason
- If this is the final story in the PRD, do not signal \`COMPLETE\` until the documentation check is done

### 6. Commit Changes

\`\`\`bash
git add .
git commit -m "feat: [${story.id}] - ${story.title}"
\`\`\`

### 7. Update PRD

Update only the current story status in the PRD file. The PRD file tracks iteration state and metadata for later phases — if you skip this, the next iteration will re-run this story, and if you rewrite the file loosely you can delete important top-level fields.

\`\`\`bash
PRD_FILE="${prdDir}/prd.json"
# Find the story with id "${story.id}" and change only its "status" to "completed"
\`\`\`

Preserve all existing top-level PRD fields such as \`testsCaughtIssue\`, \`dependencies\`, \`startedAt\`, \`completedAt\`, \`lastRun\`, and \`metrics\`.
Preserve all existing fields on the story object too. Do not replace the whole PRD or whole story with a reduced template.

The updated story should still include its existing fields, with \`status\` changed to \`completed\`:
\`\`\`json
{
  "id": "${story.id}",
  "title": "${story.title}",
  "status": "completed",
  "acceptanceCriteria": [...],
  "priority": ${story.priority}
}
\`\`\`

### 8. Append Progress

Add an entry to progress.txt:

\`\`\`markdown
## [Date/Time] - ${story.id}: ${story.title}

**What was done:**
- Brief description of implementation

**Files changed:**
- file1.ts
- file2.ts

**Documentation updates:**
- docs/file.md - what changed
- Or: No documentation update required because ...

**Patterns discovered:**
- Pattern or approach that worked well

**Mistakes corrected:**
- Description of what went wrong and how it was fixed (if any)

---
\`\`\`

If you made a mistake during implementation and corrected it, document it in "Mistakes corrected". These learnings prevent the same mistakes in future iterations.

### 9. Check for Completion

If ALL stories have \`status: "completed"\`, reply with:
\`\`\`
<promise>COMPLETE</promise>
\`\`\`

Otherwise, end your response normally. Ralph will spawn the next iteration.

</Workflow>

<Constraints>
- **One story per iteration** — implementing multiple stories makes progress tracking unreliable and rollbacks impossible
- **Read progress.txt before coding** — it contains patterns and corrections from earlier iterations that prevent repeated mistakes
- **Keep checks green** — committing with failing tests or lint errors blocks the next iteration
- **Documentation is required work** — if the change affects behavior or developer workflows, update **${DEFAULT_DOCS_GLOB}** before finishing
- **No type escape hatches** (\`any\`, \`as unknown\`) — these hide real type errors that surface as runtime bugs later
- **Work on current branch only** — the user manages branches/worktrees externally
</Constraints>

<Output_Format>

### Completion signal

After completing the story, if ALL stories have \`status: "completed"\`:
\`\`\`
<promise>COMPLETE</promise>
\`\`\`

### Blocked signal

If you cannot complete a story (unclear requirements, missing dependencies):

1. Set \`status: "blocked"\` in the story
2. Add questions to the \`questions\` array:

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

### Available commands

\`\`\`bash
npm run check         # TypeScript + lint + format check
npm test              # Run tests
npm run format        # Fix formatting
npm run lint          # Fix lint issues
\`\`\`

</Output_Format>

<Failure_Modes_To_Avoid>
- **Implementing multiple stories** — each iteration handles exactly one story; implementing more makes state tracking unreliable
- **Skipping quality checks** — committing without \`npm run check\` passing blocks the next iteration with lint/type errors
- **Not reading progress.txt** — you'll repeat mistakes and miss conventions established in earlier iterations
- **Guessing instead of blocking** — if requirements are unclear, set status to "blocked" with questions rather than guessing wrong
</Failure_Modes_To_Avoid>

<Examples>

**Good progress entry:**
\`\`\`markdown
## 2026-01-15 - US-003: Add user profile API

**What was done:**
- Created GET /api/users/:id endpoint
- Added input validation with zod schema

**Files changed:**
- src/routes/users.ts
- src/schemas/user.ts

**Patterns discovered:**
- All route files export a Hono app instance, not individual handlers

**Mistakes corrected:**
- Initially used \`as UserProfile\` type assertion, switched to proper zod .parse() which catches invalid data at runtime
\`\`\`

**Bad progress entry:**
\`\`\`markdown
## US-003
Done. Changed some files.
\`\`\`
The bad entry has no detail for future iterations to learn from.

</Examples>
`;
}

/**
 * Generates a prompt for extracting findings from a completed PRD.
 */
export async function generateFindingsExtractionPrompt(
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

	// Count completed stories
	const completedStories = prd.stories.filter((s) => s.status === "completed").length;
	const totalStories = prd.stories.length;

	return `<Role>
Extract learnings and patterns from a completed PRD's progress log for future reference.
</Role>

<Context>
**PRD:** ${prd.name} — ${prd.description}
**Created:** ${prd.createdAt}
**Completed:** ${prd.completedAt ?? "N/A"}
**Stories:** ${completedStories}/${totalStories} completed

**Spec:**
\`\`\`markdown
${specContent.slice(0, 5000)}${specContent.length > 5000 ? "\n...(truncated)" : ""}
\`\`\`

**Progress Log:**
\`\`\`
${progressContent.slice(0, 10000)}${progressContent.length > 10000 ? "\n...(truncated)" : ""}
\`\`\`
</Context>

<Extraction_Categories>

1. **Database Patterns**: Query structures, table relationships, indexing decisions
2. **API Patterns**: Endpoint structures, response formats, error handling approaches
3. **Code Patterns**: File organization conventions, naming conventions, testing approaches
4. **Business Logic Patterns**: Validation rules, state transitions, edge case handling
5. **Learnings**: What worked well, gotchas and pitfalls, recommendations for similar work

</Extraction_Categories>

<Output_Format>

Output only a markdown section that can be appended to a findings file:

\`\`\`markdown
## [DATE] ${prd.name}

**Description:** ${prd.description}

**Stories Completed:** ${completedStories}

### Patterns Discovered

- Pattern 1: Description
- Pattern 2: Description

### Key Learnings

- Learning 1: Description
- Learning 2: Description

### Code Examples (if any notable patterns)

\`\`\`language
// Example code if relevant
\`\`\`

---
\`\`\`

Replace [DATE] with today's date in YYYY-MM-DD format.

Be concise and specific. Prioritize actionable patterns that would help someone working on similar features in this codebase.
`;
}
