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

## The Job

When a user requests a PRD:

### 1. Check for Existing Documents

Before starting from scratch, check if the user has referenced or if there exist any related spec, plan, or requirements files:

- Search for existing specs, plans, or requirement docs the user mentioned
- Check `.omni/state/ralph/prds/` for related or prior PRDs on the same topic
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
- **Tradeoffs**: Speed vs. quality, simplicity vs. flexibility, consistency vs. innovation

Use the AskUserQuestion tool to present options, gather preferences, and validate your understanding. Keep interviewing until you have enough detail to write a comprehensive spec that an implementer could follow without further clarification.

### 4. Create Folder and Write spec.md

Create the PRD folder in the `pending` directory and write **only spec.md** at this stage. Do not create prd.json or progress.txt yet — the spec needs to be reviewed and confirmed before investing effort in story breakdown.

```
.omni/state/ralph/prds/pending/<prd-name>/
  └── spec.md        # Detailed feature specification
```

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

## Acceptance Criteria

The feature is complete when:

- [ ] Criterion 1
- [ ] Criterion 2
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

#### 5c. Present consolidated findings

Combine findings from all reviewers and present to the user using AskUserQuestion:

- Group issues by severity (CRITICAL, MAJOR, MINOR)
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

### 7. Write the PRD File (prd.json)

Now that the spec is confirmed, break down the work into stories:

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
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2"
      ],
      "status": "pending",
      "priority": 1,
      "questions": []
    }
  ]
}
```

**PRD fields:**

- `name`: Unique identifier (matches folder name)
- `description`: Brief description of the feature
- `createdAt`: ISO timestamp of creation
- `dependencies`: Array of PRD names that must be completed first (can be empty)

**Story fields:**

- `id`: Unique identifier (US-001, US-002, etc.)
- `title`: Short descriptive title
- `acceptanceCriteria`: Array of verifiable criteria for this chunk
- `status`: "pending" | "in_progress" | "completed" | "blocked"
- `priority`: 1-10 (lower = higher priority, do first)
- `questions`: Array of questions when blocked (empty initially)

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

The reviewer returns a verdict:

- **READY TO PROCEED**: Inform the user the PRD is ready.
- **NEEDS REVISION**: Fix critical issues, update spec.md and prd.json, then run the reviewer again. After any renumbering or restructuring, verify all FR numbers, story IDs, and priority numbers are sequential and unique. Repeat until approved.

## Best Practices

### Story Breakdown

- **5-10 stories** is typical for a feature
- **Order by dependency** — foundational work first (priority 1-2)
- **Scope appropriately** — each story completable in one iteration
- **Verifiable criteria** — acceptance criteria must be testable

### Example Stories

```json
{
  "id": "US-001",
  "title": "Set up database schema",
  "acceptanceCriteria": [
    "Migration file created",
    "Tables created with correct columns",
    "Indexes added for common queries",
    "Types generated and passing"
  ],
  "status": "pending",
  "priority": 1,
  "questions": []
}
```

```json
{
  "id": "US-002",
  "title": "Implement API endpoints",
  "acceptanceCriteria": [
    "GET endpoint returns data",
    "POST endpoint creates records",
    "Validation errors return 400",
    "Tests written and passing"
  ],
  "status": "pending",
  "priority": 2,
  "questions": []
}
```

## After Creation

After the reviewer approves, tell the user:

```
PRD created at .omni/state/ralph/prds/pending/<name>/

To start: omnidev ralph start <name>
To check:  omnidev ralph status <name>
```
