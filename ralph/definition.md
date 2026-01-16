# Ralph Orchestrator

Ralph is an AI agent orchestrator capability for OmniDev that enables long-running, PRD-driven development through iterative AI agent invocations.

## Overview

Ralph provides:

- **PRD Management** - Create, manage, and track Product Requirements Documents
- **Story Orchestration** - Execute user stories one at a time with AI agents
- **Progress Tracking** - Track progress, learnings, and codebase patterns
- **Multi-Agent Support** - Orchestrate Claude, Codex, or Amp agents
- **Lifecycle Management** - Track active vs completed work, auto-cleanup

## How It Works

1. **Create a PRD** - Define user stories with acceptance criteria and spec files
2. **Start Orchestration** - Ralph spawns an AI agent with the next incomplete story
3. **Iterate** - The agent implements the story, runs checks, and commits
4. **Track Progress** - Ralph updates the PRD and logs learnings
5. **Complete** - When all stories pass, Ralph archives the PRD

## CLI Commands

```bash
# Initialize Ralph
omnidev ralph init

# PRD management
omnidev ralph prd list
omnidev ralph prd create <name>
omnidev ralph prd select <name>
omnidev ralph prd view <name>

# Story management
omnidev ralph story list
omnidev ralph story pass <id>

# Start orchestration
omnidev ralph start --prd <name>
omnidev ralph status

# View progress
omnidev ralph log
omnidev ralph patterns
```

## Directory Structure

Ralph stores all state in `.omni/state/ralph/`:

```
.omni/state/ralph/
├── config.toml          # Ralph configuration
├── active-prd           # Currently active PRD name
├── prds/
│   └── <prd-name>/
│       ├── prd.json           # PRD definition
│       ├── progress.txt       # Progress log
│       └── specs/
│           └── 001-feature.md
└── completed-prds/
    └── 2026-01-09-feature/    # Archived PRDs
```

## Use Cases

- **Feature Development** - Break down features into stories and orchestrate implementation
- **Refactoring** - Plan and execute large refactoring efforts systematically
- **Bug Fixes** - Track and resolve multiple related bugs in sequence
- **Technical Debt** - Chip away at technical debt one story at a time
- **Learning** - Capture patterns and learnings as you build
