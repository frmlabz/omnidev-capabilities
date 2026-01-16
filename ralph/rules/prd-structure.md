# PRD Structure Rules

When creating or modifying Product Requirements Documents (PRDs), follow these structural rules to ensure consistency and proper Ralph orchestration.

## Directory Structure

1. **PRD Location**: Each PRD lives in `.omni/state/ralph/prds/<prd-name>/`
2. **Required Files**:
   - `prd.json` - The PRD definition with user stories
   - `progress.txt` - Progress log with patterns and learnings
   - `specs/` - Directory containing detailed spec files
3. **Archived PRDs**: Completed PRDs move to `.omni/state/ralph/completed-prds/YYYY-MM-DD-<prd-name>/`

## PRD JSON Schema

The `prd.json` file must contain:

```json
{
  "name": "feature-name",
  "description": "Brief description of what this PRD accomplishes",
  "createdAt": "2026-01-10T12:00:00Z",
  "dependencies": ["other-prd-name"],
  "stories": [
    {
      "id": "US-001",
      "title": "Story title",
      "acceptanceCriteria": [
        "Criteria 1",
        "Criteria 2"
      ],
      "status": "pending",
      "priority": 1,
      "questions": []
    }
  ]
}
```

### Dependencies Field

The `dependencies` array contains names of other PRDs that must be completed before this PRD can start:

- **Optional**: If omitted or empty, the PRD has no dependencies
- **Names only**: Use PRD names, not paths (e.g., `"auth-system"` not `"prds/auth-system"`)
- **Must exist**: Referenced PRDs should exist (active or archived)
- **Validation**: `omnidev ralph start` will refuse to run if dependencies are incomplete
- **Display**: `omnidev ralph list` shows dependency status for each PRD

## User Story Rules

### Story IDs
- **Format**: Must be `US-XXX` where XXX is a zero-padded number (US-001, US-002, etc.)
- **Uniqueness**: Each story must have a unique ID within the PRD
- **Sequence**: IDs should be sequential (no gaps like US-001, US-003, US-007)

### Story Titles
- **Brevity**: Keep titles under 60 characters
- **Clarity**: Title should clearly indicate what is being implemented
- **Imperative Mood**: Use action verbs (e.g., "Implement", "Create", "Add", "Update")

### Task Files
- **Path Format**: Must be relative paths in `specs/` directory (e.g., `specs/001-feature.md`)
- **File Naming**: Use format `XXX-descriptive-name.md` where XXX matches story ID number
- **Must Exist**: All referenced spec files must exist before orchestration begins

### Scope
- **Specificity**: Clearly define what part of the spec this story implements
- **Boundaries**: Indicate what is in scope and what is explicitly out of scope
- **Examples**: "Database schema only (users table)", "API endpoints only (no UI)", "Tests for core module"

### Acceptance Criteria
- **Verifiable**: Each criterion must be objectively testable
- **Specific**: Avoid vague criteria like "works correctly" or "is good"
- **Complete**: Cover all aspects of the story's scope
- **Minimal**: 2-5 criteria is ideal; break into multiple stories if more are needed

### Priority
- **Numeric**: Must be an integer starting from 1
- **Unique**: Each story should have a unique priority (determines execution order)
- **Order**: Lower numbers execute first (priority 1 before priority 2)
- **Dependencies**: Stories with dependencies should have higher priority numbers

### Passes Flag
- **Initial State**: All stories start with `passes: false`
- **Update**: Set to `true` only when all acceptance criteria are met
- **Verification**: Quality checks must pass before setting to true

### Notes
- **Optional**: Can be empty string or contain additional context
- **Use Cases**: Dependencies, known issues, links to resources, implementation notes

## Spec File Structure

Each spec file should contain:

1. **Introduction**: What needs to be done and why
2. **Goals**: High-level objectives
3. **User Stories**: Detailed acceptance criteria
4. **Functional Requirements**: Specific behaviors and edge cases
5. **Technical Considerations**: Code examples, patterns, architecture notes
6. **Touchpoints**: Files to create or modify
7. **Dependencies**: What must exist before implementation

## Progress Log Structure

The `progress.txt` file must start with:

```markdown
## Codebase Patterns

[Patterns discovered during development]

---

## Progress Log

Started: [Date]
```

Progress entries follow this format:

```markdown
## [Date/Time] - [Story ID]
- What was implemented
- Files changed: file1.ts, file2.ts
- **Learnings for future iterations:**
  - Pattern or gotcha
  - Useful approach
---
```

## Validation Rules

Before starting Ralph orchestration:

1. **PRD Exists**: `prd.json` file is present and valid JSON
2. **Stories Exist**: At least one user story is defined
3. **IDs Unique**: All story IDs are unique
4. **Priorities Unique**: All priorities are unique integers
5. **Specs Exist**: All `taskFile` paths point to existing files
6. **Dependencies Met**: All PRDs in `dependencies` array must be completed or archived
7. **Progress File**: `progress.txt` exists with correct structure

## Modification Rules

When updating PRDs:

- **Add Stories**: Append to `userStories` array with next sequential ID and priority
- **Mark Complete**: Set `passes: true` only after implementation and verification
- **Archive**: Use `omnidev ralph prd archive <name>` to move completed PRDs
- **Never Delete**: Use archive instead of deleting completed work

## Anti-Patterns

**Avoid these common mistakes:**

- ❌ Stories without spec files
- ❌ Vague acceptance criteria ("should work well")
- ❌ Large stories that take multiple iterations
- ❌ Duplicate story IDs or priorities
- ❌ Missing scope definitions
- ❌ Marking stories as passed before verification
- ❌ Skipping progress log updates
