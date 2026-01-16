---
name: ralph
description: "Execute PRD-driven development workflow. Use when working on a Ralph-managed PRD in .omni/state/ralph/prds/. Triggers on: continue ralph, work on prd, implement story, ralph iteration."
---

# Ralph Orchestration Workflow

Execute PRD-driven development by implementing one story per iteration.

## The Job

You are an autonomous coding agent working on a Ralph-managed PRD. Follow this workflow:

### 1. Read Context

**Check the PRD and progress first:**

```bash
# Read the PRD to understand the feature
cat .omni/state/ralph/prds/<prd-name>/prd.json

# Read the spec for detailed requirements
cat .omni/state/ralph/prds/<prd-name>/spec.md

# Read progress log to understand patterns and recent work
cat .omni/state/ralph/prds/<prd-name>/progress.txt
```

**Important:**
- The **spec.md** contains the feature requirements
- The **progress.txt** contains patterns discovered in previous iterations
- The **lastRun** field in prd.json shows where the previous run stopped

### 2. Pick Next Story

Look at `prd.json` and find the next story to work on:

1. Find stories with `status: "in_progress"` first (resume interrupted work)
2. Otherwise, find the lowest `priority` story with `status: "pending"`
3. Skip stories with `status: "blocked"` (waiting for user input)

### 3. Implement the Story

Follow the spec requirements and the story's acceptance criteria:

- Implement ONLY what's needed for this story
- Follow patterns from progress.txt
- Keep changes focused and minimal

### 4. Run Quality Checks

Before committing, ensure all checks pass:

```bash
bun run check      # Runs typecheck + lint + format:check
bun test           # Run tests
```

Fix any issues before proceeding.

### 5. Commit Changes

When all checks pass:

```bash
git add .
git commit -m "feat: [<story-id>] - <story-title>"
```

Example: `feat: [US-001] - Set up database schema`

### 6. Update PRD

Mark the story as completed in prd.json:

```json
{
  "id": "US-001",
  "status": "completed"
}
```

Save the updated PRD.

### 7. Append Progress

Add an entry to progress.txt:

```markdown
## [Date/Time] - US-001: Story Title

**What was done:**
- Brief description of implementation

**Files changed:**
- file1.ts
- file2.ts

**Patterns discovered:**
- Pattern or approach that worked well

---
```

### 8. Check for Completion

After updating the PRD, check if ALL stories have `status: "completed"`.

If ALL stories are complete, reply with:
```
<promise>COMPLETE</promise>
```

Otherwise, end your response normally. Ralph will spawn the next iteration.

## Handling Blocked Stories

If you cannot complete a story (unclear requirements, missing dependencies, etc.):

1. Set `status: "blocked"` in the story
2. Add your questions to the `questions` array:

```json
{
  "id": "US-003",
  "status": "blocked",
  "questions": [
    "Should the API return 404 or empty array when no results?",
    "What is the maximum page size for pagination?"
  ]
}
```

3. Reply with a summary explaining why you're blocked

Ralph will stop and present the questions to the user.

## Key Principles

- **One story per iteration** - Never implement multiple stories at once
- **Read the spec first** - The story title is just a summary
- **Keep checks green** - Never commit failing tests or lint errors
- **Document patterns** - Help future iterations by updating progress.txt
- **Ask when blocked** - Use the questions array, don't guess

## Example Iteration

```
User: Continue working on the Ralph PRD

Agent:
1. Reads prd.json - finds US-002 is next (pending, priority 2)
2. Reads spec.md - understands the requirements
3. Reads progress.txt - sees patterns from US-001
4. Implements US-002 following the spec
5. Runs checks - all pass
6. Commits on current branch: "feat: [US-002] - Add login endpoint"
7. Updates prd.json - sets US-002 to completed
8. Appends progress.txt with what was done
9. Checks - US-003 still pending, so ends normally

Ralph spawns next iteration...
```

**Note:** PRDs work on the current branch. The user manages branches/worktrees externally.
