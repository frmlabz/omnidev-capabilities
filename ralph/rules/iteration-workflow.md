# Iteration Workflow Rules

During Ralph orchestration iterations, follow these workflow rules to ensure consistent, high-quality implementation of user stories.

## Pre-Iteration: Context Gathering

### Rule 1: Always Read Progress First

**Before doing anything else, read the progress log:**

```bash
cat .omni/state/ralph/prds/<prd-name>/progress.txt
```

**Check for:**
- **Codebase Patterns**: Reusable patterns discovered in previous iterations
- **Recent Progress**: What was implemented in the last 2-3 iterations
- **Known Issues**: Gotchas or challenges to be aware of
- **Technology Stack**: Frameworks, libraries, and tools being used

**Why**: Previous iterations have already solved common problems. Don't reinvent the wheel.

### Rule 2: Work on Current Branch

PRDs work on the current branch - they don't create or switch branches.

**The user is responsible for:**
- Setting up the correct branch before starting
- Managing work trees for parallel PRD execution
- Merging completed work

**The agent should:**
- Just commit changes on the current branch
- Not run `git checkout` or `git switch`
- Not create new branches

**Why**: Agents shouldn't manage git branches - the user handles this via work trees for parallel execution.

## During Iteration: Implementation

### Rule 3: Work on ONE Story Per Iteration

**Pick the story with the lowest priority number where `passes: false`**

**Never:**
- Implement multiple stories at once
- Skip stories to work on "more interesting" ones
- Refactor code outside the current story's scope
- Add features not in the acceptance criteria

**Why**: Ralph orchestration is incremental. Each iteration builds on previous work.

### Rule 4: Read the Spec File First

**The story in prd.json is just an overview. Always read the full spec:**

```bash
cat .omni/state/ralph/prds/<prd-name>/specs/<taskFile>
```

**The spec contains:**
- Detailed requirements
- Code examples and patterns
- Files to create or modify
- Dependencies and prerequisites
- Edge cases to handle

**Pay attention to the story's `scope` field** - it tells you which part of the spec to implement.

**Why**: Specs contain critical details that aren't in the story summary.

### Rule 5: Follow Codebase Patterns

**Use patterns from progress.txt when available:**
- File reading/writing patterns
- Import conventions
- Error handling approaches
- Testing patterns
- Configuration patterns

**Don't introduce new patterns unless necessary.**

**Why**: Consistency makes the codebase easier to maintain.

### Rule 6: Implement Only What's in Scope

**Respect the story's scope boundaries:**
- If scope says "API only", don't add UI
- If scope says "types only", don't implement functions
- If scope says "database schema", don't add business logic

**Why**: Precise scope enables better estimation and progress tracking.

## Quality Checks

### Rule 7: Run Quality Checks Before Committing

**Always run before committing:**

```bash
bun run check      # typecheck + lint + format:check
bun test           # run all tests
```

**All checks must pass. Fix any issues before proceeding.**

**Never:**
- Commit with failing tests
- Commit with type errors
- Commit with lint violations
- Use type escape hatches like `any` or `as unknown`

**Why**: Quality checks prevent technical debt accumulation.

### Rule 8: Test Coverage Matters

**New code should have tests:**
- Aim for 70%+ coverage on new modules
- Test happy paths and error cases
- Test edge cases mentioned in specs

**Why**: Tests prevent regressions and verify acceptance criteria.

## Post-Implementation: Documentation

### Rule 9: Use Standard Commit Format

**Format**: `feat: [<story-id>] - <story-title>`

**Examples:**
- ✅ `feat: [US-001] - Set up authentication database schema`
- ✅ `feat: [US-012] - Implement password reset API`
- ❌ `Added auth stuff`
- ❌ `WIP`
- ❌ `feat: Implemented multiple features`

**Why**: Consistent commit messages enable better project tracking.

### Rule 10: Update PRD Immediately

**After committing, update the PRD:**

1. Open `.omni/state/ralph/prds/<prd-name>/prd.json`
2. Find the completed story
3. Change `"passes": false` to `"passes": true`
4. Save the file

**Why**: The PRD tracks which stories are complete.

### Rule 11: Append Progress with Learnings

**Add an entry to progress.txt:**

```markdown
## [Date/Time] - [Story ID]
- Brief description of implementation
- Files changed: file1.ts, file2.ts, file3.ts
- **Learnings for future iterations:**
  - Pattern discovered
  - Gotcha encountered
  - Approach that worked
---
```

**If you discover a reusable pattern, add it to the "Codebase Patterns" section at the top.**

**Why**: Future iterations benefit from your learnings.

## Completion Detection

### Rule 12: Signal Completion When Done

**After updating the PRD, check if ALL stories have `passes: true`.**

**If all complete:**
```
<promise>COMPLETE</promise>
```

**Otherwise, end your response normally.**

**Why**: This signals Ralph to stop orchestration.

## Error Handling

### Rule 13: Handle Errors Gracefully

**If you encounter blockers:**
1. Document the issue in the story's `notes` field
2. Set `passes: false` (keep it false)
3. Append details to progress.txt
4. **Do not mark the story as passed**

**If quality checks fail:**
1. Fix the issues
2. Re-run checks
3. Only commit when all checks pass

**Why**: Honest failure reporting is better than false success.

## Workflow Summary

```
1. Read progress.txt for patterns ✓
2. Pick highest priority incomplete story ✓
3. Read spec file for details ✓
4. Implement the story's scope ✓
5. Run quality checks (must pass) ✓
6. Commit with standard format ✓
7. Update prd.json (set status: "completed") ✓
8. Append progress to progress.txt ✓
9. Check for completion signal ✓
```

## Anti-Patterns

**Avoid these workflow mistakes:**

- ❌ Skipping quality checks
- ❌ Working on multiple stories at once
- ❌ Committing before reading the spec
- ❌ Using `any` types or `--no-verify` git flag
- ❌ Implementing features outside the scope
- ❌ Forgetting to update PRD or progress
- ❌ Not reading progress.txt first
- ❌ Creating or switching git branches
- ❌ Marking stories completed before verification
