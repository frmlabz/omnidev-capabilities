---
name: prd
description: "Generate a Product Requirements Document (PRD) for a new feature. Use when planning a feature, starting a new project, or when asked to create a PRD. Triggers on: create a prd, write prd for, plan this feature, requirements for, spec out."
---

# PRD Generator

Create structured PRDs for Ralph orchestration to enable AI-driven development.

<Use_When>
- User wants to plan a new feature or project
- User asks to create a PRD, write requirements, or spec out a feature
- User says "plan this feature" or "requirements for"
</Use_When>

<Do_Not_Use_When>
- User wants to modify an existing PRD (edit the files directly instead)
- User wants to review a PRD (use the prd-reviewer subagent)
- User wants to start implementation (use `omnidev ralph start`)
</Do_Not_Use_When>

## Grilling Mode

**Opt-in, per invocation.** If the user's PRD request mentions "grill" (e.g. "grill this PRD", "grill the spec", "write a PRD and grill it"), enable **grilling mode** for the whole session. Otherwise it's off.

When grilling mode is **on**:
- Step 5 runs the spec cross-examine loop between `spec-reviewer` and the external `review_agent`.
- Step 9 runs the PRD cross-examine loop between `prd-reviewer` and the external `review_agent`.
- Both require `[ralph.review].review_agent` to be configured. If it is not, tell the user grilling was requested but no external reviewer is configured, then continue with internal reviewers only.

When grilling mode is **off**: skip the cross-examine steps entirely. The single-pass internal + optional external review still runs as normal.

There is no config flag. The trigger is the user's words.

## The Job

When a user requests a PRD:

### 1. Check for Existing Documents

Before starting from scratch, check if the user has referenced or if there exist any related spec, plan, or requirements files:

- Search for existing specs, plans, or requirement docs the user mentioned
- Run `omnidev ralph list --all` to check for related or prior PRDs on the same topic
- If found, use them as the foundation and expand from there — recreating existing work wastes time and loses context

### 2. Research & Explore

Before interviewing, gather context using specialized agents so you can ask informed questions:

#### Use the `explore` agent to understand the codebase

- Find existing patterns and conventions (export patterns, manifest files, config conventions)
- Locate related code that the feature will integrate with
- Identify dependencies and constraints
- Understand the project structure

#### Use the `research` agent for external knowledge

- Best practices for the feature type
- Library/framework documentation
- Common pitfalls and edge cases
- Security considerations

This context helps you ask better questions and identify constraints the user may not be aware of.

### 3. Interview the User

With codebase and domain knowledge in hand, conduct an in-depth interview using the AskUserQuestion tool.

**Interview approach:**

- Ask about anything relevant: technical implementation, UI/UX design, user flows, performance concerns, security implications, tradeoffs, edge cases, error handling, future extensibility, integration points, data modeling, state management, testing strategy, deployment considerations, etc.
- Avoid obvious questions — use your research and codebase exploration to ask informed, specific questions that demonstrate understanding
- Continue interviewing in multiple rounds until you have a complete picture
- Surface tradeoffs you've identified and ask the user to choose between approaches
- Challenge assumptions — if something seems unclear or potentially problematic, probe deeper

**Topics to explore (as relevant to the feature):**

- **Technical implementation**: Architecture decisions, patterns to follow, performance requirements, scalability concerns
- **UI/UX**: User flows, interaction patterns, responsive design, accessibility, error states, loading states, empty states
- **Data & state**: Data structures, storage, caching, synchronization, validation rules
- **Integration**: How it connects to existing systems, API contracts, backwards compatibility
- **Edge cases**: Failure modes, race conditions, concurrent access, resource limits
- **Security**: Authentication, authorization, input validation, data exposure
- **Testing**: What needs to be tested, acceptance criteria, how to verify correctness
- **Documentation**: Which files under `docs/**/*.md` may need updates, what workflows or APIs must be documented, and whether a dedicated documentation story is needed
- **Tradeoffs**: Speed vs. quality, simplicity vs. flexibility, consistency vs. innovation

Use the AskUserQuestion tool to present options, gather preferences, and validate your understanding. Keep interviewing until you have enough detail to write a comprehensive spec that an implementer could follow without further clarification.

### 4. Create Folder and Write spec.md

Create the PRD folder in the `pending` directory and write **only spec.md** at this stage. Do not create prd.json or progress.txt yet — the spec needs to be reviewed and confirmed before investing effort in story breakdown.

```
$XDG_STATE_HOME/omnidev/ralph/<project>/prds/pending/<prd-name>/
  └── spec.md        # Detailed feature specification
```

(Defaults to `~/.local/state/omnidev/ralph/<project>/prds/pending/<prd-name>/`)

Do not create `prd.json`, `stories/`, or `progress.txt` at this step. Those are written in step 7 after the spec is reviewed and approved.

The spec describes WHAT the feature should do (requirements), NOT HOW to implement it.

```markdown
# Feature Name

## Overview

Brief description of the feature and its purpose.

## Goals

- Goal 1
- Goal 2

## Requirements

### Functional Requirements

- FR-1: Description of requirement
- FR-2: Description of requirement

### Edge Cases

- What happens when X?
- How to handle Y?

## Documentation Impact

- Docs that may need updates under `docs/**/*.md`
- Commands, config, API contracts, or workflows that must be documented
- Whether the PRD should end with a dedicated documentation update step

## Acceptance Criteria

The feature is complete when:

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] All required documentation updates under `docs/**/*.md` are complete
- [ ] All tests pass
- [ ] No type errors
```

### 5. Spec Review Loop

Before creating stories, the spec must be reviewed to catch requirements issues early. Run both internal and external (if configured) reviews, then present findings to the user.

#### 5a. Run the spec-reviewer agent

Invoke the `spec-reviewer` subagent using the Task tool. Pass the full content of spec.md for review. The reviewer evaluates requirements quality, problem/goal alignment, edge cases, consistency, and implementability.

#### 5b. Run external review (if configured)

Check `omni.toml` for `[ralph.review]` configuration:

```toml
[ralph.review]
review_agent = "codex"  # or "" (default — disabled)
```

If `review_agent` is set (non-empty):

1. Look up the agent's command and args from `[ralph.agents.<name>]` in omni.toml
2. Invoke it via Bash, piping a spec review prompt to stdin:

```
echo "<prompt with spec content>" | <command> <args>
```

The prompt should ask the external tool to review the spec for clarity, completeness, edge cases, and implementability — the same concerns as the spec-reviewer but from an independent perspective.

If `review_agent` is empty or not configured, skip this step.

#### 5c. Cross-examine (grilling mode only)

Run this step **only when all three hold**: grilling mode is on (see "Grilling Mode" at the top), `review_agent` is non-empty, and at least one reviewer produced findings. Otherwise skip to 5d.

The purpose is adversarial pressure: each side must defend its own findings and grade the opponent's.

1. **Internal cross-exam.** Re-invoke `spec-reviewer` via the Task tool with a cross-examine prompt:
   - Attach its own previous findings AND the external reviewer's findings
   - Ask it to produce, for each of its own findings, one of: `DEFEND` (with reasoning) or `WITHDRAW` (with reason)
   - Ask it to produce, for each external finding, one of: `CONCEDE` (agree, spec should change) or `CHALLENGE` (disagree, with reasoning)
2. **External cross-exam.** Invoke the external `review_agent` via Bash with the mirrored prompt — its own findings + spec-reviewer's findings, same DEFEND/WITHDRAW/CONCEDE/CHALLENGE contract.
3. **Classify each finding:**
   - `withdrawn` — the author withdrew it (drop from user-facing list entirely, except in a collapsed "Withdrawn" section for transparency)
   - `confirmed` — the author defended AND the opponent conceded, OR the opponent did not challenge it at all
   - `contested` — the author defended AND the opponent challenged. Attach both reasoning snippets.

Do not invent a new severity tier — `contested` is an orthogonal dimension to CRITICAL/MAJOR/MINOR. Preserve the original severity when presenting.

#### 5d. Present consolidated findings

Combine findings from all reviewers and present to the user using AskUserQuestion:

- Group issues by severity (CRITICAL, MAJOR, MINOR)
- When grilling mode ran, split each severity into **Confirmed** and **Contested** subsections. Show both sides' reasoning for contested items. Show a collapsed **Withdrawn** list at the bottom.
- Include any questions from the reviewers
- Ask the user: **Address the issues, or approve the spec as-is?**

Options:
- **Address issues**: Update spec.md based on findings, then loop back to step 5a
- **Approve as-is**: Accept the spec and proceed to story creation

Keep iterating until the user approves the spec.

### 6. User Confirmation

Present a brief summary of what the final spec covers:

- The problem being solved
- Key requirements (count of FRs)
- Edge cases covered
- Acceptance criteria

Ask the user to confirm they're ready to proceed with story creation. This is the last checkpoint before investing effort in the prd.json breakdown.

### 7. Write prd.json and stories/<id>.md

Now that the spec is confirmed, break down the work into stories. **The story file is the source of truth for scope and acceptance criteria; `prd.json` only holds metadata and a `promptPath` pointing at the story file.** Putting `acceptanceCriteria` inside `prd.json` will fail Zod validation (`promptPath` is required, `acceptanceCriteria` is not a known field).

Write both files under the PRD directory:

```
<prd-dir>/
├── prd.json
└── stories/
    ├── US-001.md
    ├── US-002.md
    └── ...
```

#### 7a. prd.json (strict shape)

```json
{
  "name": "feature-name",
  "description": "Brief description of the feature",
  "createdAt": "2026-01-10T12:00:00Z",
  "dependencies": [],
  "stories": [
    {
      "id": "US-001",
      "title": "Story title",
      "promptPath": "stories/US-001.md",
      "status": "pending",
      "priority": 1,
      "questions": []
    }
  ]
}
```

**Hard rules — these will fail Zod validation if violated:**

- `createdAt` MUST be an ISO-8601 datetime ending in `Z` (UTC). `+02:00`, `+0000`, or no-suffix values are rejected by `z.string().datetime()`.
- Every story MUST include `promptPath` (relative to the PRD dir, typically `stories/<id>.md`). The file at that path must exist before `omnidev ralph start` runs.
- Do NOT put `acceptanceCriteria` on a story in `prd.json`. It belongs in the story file under `## Acceptance Criteria`.
- `priority` is a positive integer. FR numbers, story IDs, and priorities must be sequential and unique.
- `status` starts as `"pending"` for every story.

**PRD fields:**

- `name`: Unique identifier (matches folder name)
- `description`: Brief description of the feature
- `createdAt`: ISO timestamp, UTC, `Z`-suffixed (e.g. `"2026-01-10T12:00:00Z"`)
- `dependencies`: Array of PRD names that must be completed first (can be empty)

**Story fields (in prd.json):**

- `id`: Unique identifier (US-001, US-002, …)
- `title`: Short descriptive title
- `promptPath`: Relative path to the story markdown file, e.g. `"stories/US-001.md"`
- `status`: always `"pending"` at creation
- `priority`: 1, 2, 3, … (lower = higher priority)
- `questions`: `[]` at creation

#### 7b. stories/<id>.md (one file per story)

Each story file carries the scope and acceptance criteria. Use this template verbatim — the front-matter keys and the section headers (`## Goal`, `## Scope`, `## Out of scope`, `## Deliverables`, `## Acceptance Criteria`) are load-bearing.

```markdown
---
id: US-001
title: Story title
priority: 1
dependencies: []
---

## Goal
One-sentence outcome for this story.

## Scope
- What this story changes
- Files or modules it touches

## Out of scope
- Anything deliberately left for a later story

## Deliverables
1. Concrete artifact 1
2. Concrete artifact 2

## Acceptance Criteria
- [ ] Verifiable criterion 1
- [ ] Verifiable criterion 2
- [ ] Tests, typecheck, and lint pass
```

**Documentation expectations for story creation:**

- During story breakdown, explicitly evaluate whether the PRD changes behavior, APIs, configuration, commands, or developer workflows
- If yes, add a final story dedicated to updating the affected files under `docs/**/*.md`
- The final story should capture which docs need to change and what must be verified

### Dependencies

If this PRD depends on other PRDs being completed first, add them to the `dependencies` array:

```json
{
  "name": "user-dashboard",
  "dependencies": ["auth-system", "user-profile"],
  ...
}
```

**When to use dependencies:**

- The feature requires code from another PRD
- There's a logical order (e.g., database schema before API)
- Multiple PRDs are planned and should run in sequence

`omnidev ralph start` will refuse to run a PRD with incomplete dependencies.

### 8. Create Empty Progress File

```
## Codebase Patterns

(Patterns discovered during implementation will be added here)

---

## Progress Log

Started: [Date]
```

### 9. Run PRD Review (Automatic)

After writing prd.json, immediately run the `prd-reviewer` agent. This reviewer checks the complete PRD (spec.md + prd.json together) for structural quality and goal alignment — story ordering, dependency chains, sizing, and acceptance criteria testability.

**If grilling mode is on AND `review_agent` is non-empty**, also run the external reviewer against the combined spec.md + prd.json, then cross-examine using the same protocol as step 5c (DEFEND / WITHDRAW / CONCEDE / CHALLENGE → classify into confirmed / contested / withdrawn). Present contested findings to the user with both sides' reasoning. If grilling mode is off, the external reviewer is not invoked at this step.

The reviewer returns a verdict:

- **READY TO PROCEED**: Inform the user the PRD is ready.
- **NEEDS REVISION**: Fix critical issues, update spec.md and prd.json, then run the reviewer again. After any renumbering or restructuring, verify all FR numbers, story IDs, and priority numbers are sequential and unique. Repeat until approved.

## Best Practices

### Story Breakdown

- **5-10 stories** is typical for a feature
- **Order by dependency** — foundational work first (priority 1-2)
- **Scope appropriately** — each story completable in one iteration
- **Verifiable criteria** — acceptance criteria must be testable

### Example Story

`prd.json` entry (metadata only — no `acceptanceCriteria` field here):

```json
{
  "id": "US-001",
  "title": "Set up database schema",
  "promptPath": "stories/US-001.md",
  "status": "pending",
  "priority": 1,
  "questions": []
}
```

`stories/US-001.md` (source of truth for scope + AC):

```markdown
---
id: US-001
title: Set up database schema
priority: 1
dependencies: []
---

## Goal
Land the baseline database schema the rest of the feature depends on.

## Scope
- New migration under `db/migrations/`
- Kysely types regenerated

## Out of scope
- Seeding production data

## Deliverables
1. Migration file applied cleanly on a fresh DB
2. Regenerated Kysely types committed

## Acceptance Criteria
- [ ] Migration file created and applies cleanly
- [ ] Tables created with correct columns and constraints
- [ ] Indexes added for common queries
- [ ] Kysely types regenerated and typecheck passes
- [ ] Lint passes
```

## After Creation

After the reviewer approves, tell the user:

```
PRD created in pending status.

To start: omnidev ralph start <name>
To check:  omnidev ralph status <name>
```
