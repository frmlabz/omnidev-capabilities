# Ralph - AI Agent Orchestrator

Ralph is a built-in OmniDev capability that enables PRD-driven development through iterative AI agent invocations. Each iteration works on one user story until all acceptance criteria are met.

## Features

- **Multi-Agent Support** — Works with Claude, Codex, or Amp agents
- **PRD-Driven** — Structured Product Requirements Documents with user stories
- **Progress Tracking** — Maintains progress logs and codebase patterns
- **Auto-Archive** — Completed PRDs are automatically archived

## State Structure

```
.omni/state/ralph/
├── config.toml          # Agent configs, iteration settings
├── active-prd           # Currently active PRD name
├── prds/
│   └── <prd-name>/
│       ├── prd.json     # PRD definition with stories
│       ├── progress.txt # Progress log
│       └── specs/       # Detailed spec files
└── completed-prds/      # Archived completed PRDs
```

## CLI Commands

### Core Commands

```bash
# Initialize Ralph in project
omnidev ralph init

# Start orchestration for active PRD
omnidev ralph start [--agent <agent>] [--iterations <n>] [--prd <name>]

# Stop running orchestration
omnidev ralph stop

# View status of PRDs and stories
omnidev ralph status [--prd <name>]
```

### PRD Management

```bash
# List all PRDs
omnidev ralph prd list [--all]

# Create new PRD
omnidev ralph prd create <name> [--from <spec-file>]

# Set active PRD
omnidev ralph prd select <name>

# Archive completed PRD
omnidev ralph prd archive <name>
```

### Story Management

```bash
# List stories in active PRD
omnidev ralph story list [--prd <name>]

# Mark story as passed
omnidev ralph story pass <story-id> [--prd <name>]

# Mark story as failed
omnidev ralph story reset <story-id> [--prd <name>]

# Add story to PRD
omnidev ralph story add <title> --spec <spec-file> [--prd <name>]
```

### Spec Management

```bash
# List specs in a PRD
omnidev ralph spec list [--prd <name>]

# Create new spec
omnidev ralph spec create <name> [--prd <name>]
```

### Utility Commands

```bash
# View progress log
omnidev ralph log [--prd <name>] [--tail <n>]

# View codebase patterns
omnidev ralph patterns [--prd <name>]

# Clean up old completed PRDs
omnidev ralph cleanup [--older-than <days>]
```

## Configuration

### `.omni/state/ralph/config.toml`

```toml
[ralph]
default_agent = "claude"      # claude, codex, amp
default_iterations = 10
auto_archive = true           # Archive PRDs when all stories pass

[agents.claude]
command = "npx -y @anthropic-ai/claude-code"
args = ["--model", "sonnet", "--dangerously-skip-permissions", "-p"]

[agents.codex]
command = "npx -y @openai/codex"
args = ["exec", "-c", "shell_environment_policy.inherit=all", "--dangerously-bypass-approvals-and-sandbox", "-"]

[agents.amp]
command = "amp"
args = ["--dangerously-allow-all"]
```

## PRD Structure

### `prd.json`

```json
{
  "name": "user-auth",
  "description": "User authentication system",
  "createdAt": "2026-01-09T10:00:00Z",
  "dependencies": ["database-setup"],
  "stories": [
    {
      "id": "US-001",
      "title": "Database schema for users",
      "acceptanceCriteria": [
        "Users table created",
        "Migration runs successfully",
        "Typecheck passes"
      ],
      "status": "pending",
      "priority": 1,
      "questions": []
    }
  ]
}
```

### Dependencies

PRDs can depend on other PRDs. The `dependencies` array lists PRD names that must be completed before this one can start:

- `omnidev ralph list` shows dependency status for each PRD
- `omnidev ralph start` refuses to run if dependencies are not complete
- Completed dependencies are checked in both active and archived PRDs

## Example Workflow

```bash
# 1. Initialize Ralph
omnidev ralph init

# 2. Create a new PRD
omnidev ralph prd create user-auth

# 3. Add specs and stories
omnidev ralph spec create database-schema --prd user-auth
omnidev ralph story add "Database schema" --spec specs/001-database-schema.md

# 4. Start orchestration
omnidev ralph start --prd user-auth --agent claude --iterations 20

# 5. Monitor progress
omnidev ralph status
omnidev ralph log --tail 50
```

## Sandbox API

Ralph exports functions for use in `omni_execute`:

```typescript
import * as ralph from "ralph";

// PRD operations
await ralph.listPRDs();
await ralph.getPRD("user-auth");
await ralph.createPRD("user-auth", { description: "..." });
await ralph.archivePRD("user-auth");

// Story operations
await ralph.getNextStory("user-auth");
await ralph.markStoryPassed("user-auth", "US-001");
await ralph.markStoryFailed("user-auth", "US-001");

// Progress operations
await ralph.appendProgress("user-auth", "Completed schema...");
await ralph.getProgress("user-auth");
await ralph.getPatterns("user-auth");

// Active PRD
await ralph.getActivePRD();
await ralph.setActivePRD("user-auth");
```

## Skills

Ralph includes skills for AI agents:

- **prd-creation** — Guides AI in creating well-structured PRDs
- **ralph-orchestration** — Defines the iteration workflow

## Rules

- **prd-structure.md** — Format requirements for PRD files
- **iteration-workflow.md** — How agents should work through stories

