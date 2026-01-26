# Ralph - PRD-Driven Development Orchestrator

Ralph automates feature development by breaking PRDs (Product Requirements Documents) into stories and orchestrating AI agents to implement them iteratively.

## Getting Started

Ralph is a capability for [OmniDev](https://github.com/frmlabz/omnidev). Install OmniDev first, then run:

```bash
omnidev init 
omnidev add cap --github frmlabz/omnidev-capabilities --path ralph
omnidev sync
```

This creates the Ralph directory structure at `.omni/state/ralph/`.

## Common Commands

```bash
# List all PRDs with status
omnidev ralph list

# Show detailed status of a PRD
omnidev ralph status <prd-name>

# Start working on a PRD (runs AI agent iterations)
omnidev ralph start <prd-name>

# View progress log
omnidev ralph progress <prd-name>

# View spec file
omnidev ralph spec <prd-name>

# Complete a PRD (extract findings via LLM, move to completed)
omnidev ralph complete <prd-name>

# Move PRD between states manually
omnidev ralph prd <prd-name> --move <status>
```

## PRD Lifecycle

PRDs move through three states:

| Status | Description |
|--------|-------------|
| `pending` | Active development - stories being implemented |
| `testing` | All stories done, awaiting manual verification |
| `completed` | Verified and findings extracted |

When all stories are completed, the PRD automatically moves to `testing`. After you verify the implementation works, run `omnidev ralph complete <name>` to extract findings and move to `completed`.

## PRD Structure

Each PRD lives in `.omni/state/ralph/prds/<status>/<prd-name>/` with three files:

### `prd.json`

The PRD definition with metadata and stories:

```json
{
  "name": "feature-name",
  "description": "Brief description",
  "stories": [
    {
      "id": "US-001",
      "title": "Story title",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "status": "pending",
      "priority": 1,
      "questions": []
    }
  ]
}
```

Story statuses: `pending`, `in_progress`, `completed`, `blocked`

### `spec.md`

Detailed feature requirements in markdown. The AI agent reads this to understand what to build.

### `progress.txt`

Log of work done across iterations. Contains:

- What was implemented per story
- Files changed
- Patterns discovered (used by future iterations)

## Configuration

Agent configuration lives in `.omni/state/ralph/config.toml`:

```toml
[ralph]
default_agent = "claude"
default_iterations = 10

[agents.claude]
command = "npx"
args = ["-y", "@anthropic-ai/claude-code", "--model", "sonnet", "--dangerously-skip-permissions", "-p"]
```

## Findings

When completing a PRD, Ralph extracts patterns and learnings into `.omni/state/ralph/findings.md`. This serves as institutional knowledge for the codebase.

## Dependencies

PRDs can depend on other PRDs via the `dependencies` array. A PRD cannot start until all its dependencies are completed.

```json
{
  "name": "user-dashboard",
  "dependencies": ["user-auth", "database-setup"]
}
```
