/**
 * Ralph Prompt Generator
 *
 * Generates agent prompts from PRD context for orchestration. Per FR-1, the
 * story file at `stories/<id>.md` is the source of truth: this module reads
 * it verbatim and prepends a minimal header (PRD name, story id, link to
 * spec.md, last 20 lines of progress.txt, prior Q&A).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findPRDLocation, getProgress, getPRD, getSpec } from "./state.js";
import { getStatusDir } from "./core/paths.js";
import type { PRD, Story } from "./types.js";

const DEFAULT_DOCS_GLOB = "docs/**/*.md";

/**
 * Generate a prompt for the dev agent. The story file is loaded verbatim
 * and becomes the bulk of the prompt; the header is intentionally minimal.
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

	const storyFilePath = join(prdDir, story.promptPath);
	if (!existsSync(storyFilePath)) {
		throw new Error(
			`Story file missing at ${storyFilePath}. This PRD may need to be migrated (run 'ralph migrate').`,
		);
	}
	const storyFileContent = await readFile(storyFilePath, "utf-8");

	const progressContent = await getProgress(projectName, repoRoot, prdName);
	const progressLines = progressContent.split("\n");
	const recentProgress = progressLines.slice(-20).join("\n");

	let questionsAnswersText = "";
	if (story.answers && story.answers.length > 0) {
		questionsAnswersText = "\n\n**Previous Questions & User Answers:**\n";
		for (let i = 0; i < story.questions.length; i++) {
			const question = story.questions[i];
			const answer = story.answers[i];
			questionsAnswersText += `  Q${i + 1}: ${question}\n`;
			questionsAnswersText += `  A${i + 1}: ${answer}\n\n`;
		}
	} else if (story.questions && story.questions.length > 0) {
		questionsAnswersText = "\n\n**Verifier / prior feedback to address on this iteration:**\n";
		for (const q of story.questions) {
			questionsAnswersText += `  - ${q}\n`;
		}
	}

	const otherStories = prd.stories
		.filter((s) => s.id !== story.id)
		.map((s) => `  - ${s.id}: ${s.title} [${s.status}]`)
		.join("\n");

	return `<Role>
Autonomous coding agent working on a Ralph-managed PRD. You implement one story per iteration, then signal completion.
</Role>

<Context>
**PRD:** ${prd.name} — ${prd.description}

**Spec file (full design doc):** \`${prdDir}/spec.md\`

**Other stories in this PRD:**
${otherStories || "  (none)"}

**Recent progress (last 20 lines of progress.txt):**
\`\`\`
${recentProgress || "(no progress yet)"}
\`\`\`${questionsAnswersText}
</Context>

<Current_Story>
Story file: \`${prdDir}/${story.promptPath}\`

${storyFileContent}
</Current_Story>

<Workflow>

### 1. Read Context

Before writing code:

\`\`\`bash
cat ${prdDir}/prd.json
cat ${prdDir}/spec.md
cat ${prdDir}/progress.txt
rg --files docs -g '*.md'
\`\`\`

- **spec.md** has the high-level feature design
- **progress.txt** has patterns discovered in previous iterations and the prior run's stop point
- **${DEFAULT_DOCS_GLOB}** should be checked whenever behavior, APIs, UI, configuration, or workflows changed

### 2. Implement the Story

Implement exactly what the story file says. The \`## Acceptance Criteria\` section lists code-level checks the per-story verifier will run against your diff.

- Before writing new code, follow patterns from similar modules in this codebase (export patterns, manifest files, config conventions)
- Implement only what's needed for this story
- Treat documentation as part of the deliverable, not post-hoc cleanup
- If this story changes user-facing behavior, developer workflows, configuration, or APIs, update the affected files under **${DEFAULT_DOCS_GLOB}**

### 3. Run Quality Checks

\`\`\`bash
npm run check      # Runs typecheck + lint + format:check
npm test           # Run tests
\`\`\`

Fix any issues before proceeding.

### 4. Commit Changes

\`\`\`bash
git add .
git commit -m "feat: [${story.id}] - ${story.title}"
\`\`\`

### 5. Update PRD

Change only the current story's \`status\` to \`completed\` in \`${prdDir}/prd.json\`. Preserve all other fields.

### 6. Append Progress

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

### 7. Check for Completion

If ALL stories have \`status: "completed"\`, reply with:
\`\`\`
<promise>COMPLETE</promise>
\`\`\`

Otherwise, end your response normally. Ralph will spawn the next iteration.

</Workflow>

<Constraints>
- **One story per iteration** — implementing multiple stories makes progress tracking unreliable and rollbacks impossible
- **Read progress.txt before coding** — it contains patterns and corrections from earlier iterations
- **Keep checks green** — committing with failing tests or lint errors blocks the next iteration
- **Documentation is required work** — update **${DEFAULT_DOCS_GLOB}** when behavior changes
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
2. Add questions to the \`questions\` array in prd.json

Ralph will stop and present the questions to the user.

</Output_Format>
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
${specContent}
\`\`\`

**Progress Log:**
\`\`\`
${progressContent}
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

---
\`\`\`

Replace [DATE] with today's date in YYYY-MM-DD format.

Be concise and specific. Prioritize actionable patterns that would help someone working on similar features in this codebase.
`;
}
