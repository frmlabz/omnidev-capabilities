---
name: prd
description: "Generate a Product Requirements Document (PRD) for a new feature. Use when planning a feature, starting a new project, or when asked to create a PRD. Triggers on: create a prd, write prd for, plan this feature, requirements for, spec out."
---

# PRD Generator

Create structured PRDs for Ralph orchestration to enable AI-driven development.

## The Job

When a user requests a PRD:

### 1. Interview the User

**Before writing anything**, ask clarifying questions to understand:

- **What is the feature?** Get a clear, concise description
- **Who is it for?** Target users and use cases
- **What are the key requirements?** Must-have functionality
- **What are the edge cases?** Error handling, validation, limits
- **What are the acceptance criteria?** How do we know it's done?
- **Any technical constraints?** Existing patterns, dependencies, limitations

Ask 3-5 focused questions. Don't proceed until you have clear answers.

### 2. Create the PRD Folder Structure

```
.omni/state/ralph/prds/<prd-name>/
  ├── prd.json       # Orchestration file with stories
  ├── spec.md        # Detailed feature specification
  └── progress.txt   # Progress log (empty initially)
```

### 3. Write the Spec File (spec.md)

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

### 4. Write the PRD File (prd.json)

Break down the work into stories (manageable chunks):

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

**Note:** `omnidev ralph start` will refuse to run a PRD with incomplete dependencies.

### 5. Create Empty Progress File

```
## Codebase Patterns

(Patterns discovered during implementation will be added here)

---

## Progress Log

Started: [Date]
```

## Best Practices

### Story Breakdown

- **5-10 stories** is typical for a feature
- **Order by dependency** - foundational work first (priority 1-2)
- **Scope appropriately** - each story completable in one iteration
- **Verifiable criteria** - acceptance criteria must be testable

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

## Quality Checks

Before finalizing:

- [ ] User has confirmed understanding of requirements
- [ ] spec.md describes the feature requirements clearly
- [ ] All stories have unique IDs in sequence
- [ ] Priorities are ordered correctly (1-10, no gaps)
- [ ] Acceptance criteria are specific and verifiable
- [ ] Stories build on each other logically

## After Creation

Tell the user:

```
PRD created at .omni/state/ralph/prds/<name>/

To start Ralph orchestration:
  omnidev ralph start <name>

To check status:
  omnidev ralph status <name>
```
