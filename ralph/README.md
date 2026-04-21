# Ralph - PRD-Driven Development Orchestrator

Ralph automates feature development by breaking PRDs (Product Requirements Documents) into stories and orchestrating AI agents to implement them iteratively. It includes a full QA feedback loop with automated testing.

## Getting Started

Ralph is a capability for [OmniDev](https://github.com/frmlabz/omnidev). Install OmniDev first, then run:

```bash
omnidev init
omnidev add cap --github frmlabz/omnidev-capabilities --path ralph
omnidev sync
```

This creates the Ralph directory structure at `$XDG_STATE_HOME/omnidev/ralph/<project>/` (defaults to `~/.local/state/omnidev/ralph/<project>/`).

After setup, add the `[ralph]` configuration to your `omni.toml` file (see Configuration section below).

## Commands

```bash
# List all PRDs with status
omnidev ralph list

# Show detailed status of a PRD
omnidev ralph status <prd-name>

# Start working on a PRD (runs AI agent iterations)
omnidev ralph start <prd-name>

# Run automated tests for a PRD
omnidev ralph test <prd-name>

# View progress log
omnidev ralph progress <prd-name>

# View spec file
omnidev ralph spec <prd-name>

# Complete a PRD manually (extract findings, move to completed)
omnidev ralph complete <prd-name>

# Move PRD between states manually
omnidev ralph prd <prd-name> --move <status>
```

## Parallel Execution (Swarm)

Run multiple PRDs in parallel using git worktrees and tmux sessions:

```bash
# Start a PRD in a worktree + tmux session
omnidev ralph swarm start <prd-name> [--agent <agent>]

# Start test agent in a worktree
omnidev ralph swarm test <prd-name> [--agent <agent>]

# List running swarm sessions
omnidev ralph swarm list

# Attach to a running session
omnidev ralph swarm attach <prd-name>

# View logs
omnidev ralph swarm logs <prd-name> [--tail <n>]

# Stop a session (or all)
omnidev ralph swarm stop <prd-name> | --all

# Merge worktree changes back
omnidev ralph swarm merge <prd-name> | --all

# Show merge conflicts
omnidev ralph swarm conflicts <prd-name>

# Clean up worktree + session
omnidev ralph swarm cleanup <prd-name> | --all

# Recover orphaned worktrees
omnidev ralph swarm recover
```

Each swarm session runs in an isolated git worktree, so multiple PRDs can be developed simultaneously without conflicts.

### Custom Worktree Creation

By default, swarm uses `git worktree add` programmatically. If you have a custom tool that creates worktrees (e.g., with extra hooks), configure it:

```toml
[ralph.swarm]
worktree_create_cmd = "wt switch --create --no-cd --yes {name}"
```

Available placeholders: `{name}` (PRD name), `{path}` (resolved worktree path), `{branch}` (branch name).

When set, the custom command runs inside the tmux pane as a prefix to the agent command instead of the default `git worktree add`.
Ralph always `cd`s into `{path}` and verifies the expected branch before starting, so custom tools do not need to manage shell directory switching.
If the command starts with `wt`, Ralph also sets `WORKTRUNK_SKIP_SHELL_INTEGRATION_PROMPT=true` to avoid interactive shell-install prompts in tmux panes.

## PRD Lifecycle

PRDs move through three states:

```
┌──────────┐    ┌──────────┐    ┌───────────┐
│ PENDING  │───▶│ TESTING  │───▶│ COMPLETED │
│          │    │          │    │           │
└──────────┘    └──────────┘    └───────────┘
     ▲               │
     │               │ PRD_FAILED
     │               ▼
     │         ┌──────────┐
     └─────────│ Fix Story│
               │ Created  │
               └──────────┘
```

| Status | Description |
|--------|-------------|
| `pending` | PRD created but not yet started |
| `in_progress` | Active development - stories being implemented |
| `testing` | All stories done, verification checklist generated, ready for testing |
| `completed` | Verified and findings extracted |

### Automatic Transitions

1. **Start PRD** → PRD moves from `pending` to `in_progress`
2. **Story marked complete by dev agent** → **Per-story verifier runs** (if enabled) → on PASS the story stays completed; on FAIL it is reverted to `in_progress` once with failed ACs as questions, then blocked on a second FAIL
3. **All stories complete** → Findings extracted → **Code review pipeline runs** (unless the PRD came back from testing after a failure) → PRD moves to `testing`, verification.md auto-generated with documentation checks
4. **Tests pass (PRD_VERIFIED)** → Final documentation safety-net runs → Uncommitted changes auto-committed → PRD moves to `completed`, findings extracted
5. **Tests fail (PRD_FAILED)** → Fix story created, PRD moves back to `in_progress`

## Documentation Is Part Of Done

Documentation is not just a cleanup step at the end. When a PRD changes behavior, APIs, commands, configuration, UI flows, or developer workflows, Ralph expects the relevant files under `docs/**/*.md` to be updated as part of implementation.

New PRDs should explicitly assess documentation impact and usually include a final documentation story when docs are affected. Verification and testing should also check that required docs were updated before a PRD can be considered verified.

## Per-Story Verification

After the dev agent signals a story complete, Ralph runs a cheap checklist auditor (`story-verifier` subagent) against that story's git diff and acceptance criteria. This catches "I'm done" misses at the smallest scope possible, before the story gets folded into the PRD-level review.

### How it works

1. When a story first transitions `pending → in_progress`, Ralph records the current `HEAD` SHA on the story as `startCommit`.
2. When the story is marked complete, Ralph computes `git diff <startCommit>..HEAD` (truncated at 3000 chars), feeds it plus the acceptance criteria to the verifier agent, and parses its structured output.
3. The verifier emits a per-AC verdict (`met` / `partial` / `unmet`) and one overall `PASS` or `FAIL`. A single non-`met` AC forces FAIL.
4. On FAIL, Ralph reverts the story to `in_progress`, appends the failed ACs as questions, and lets the dev agent retry once. A second FAIL blocks the story.

The verifier is a checklist auditor, not a code reviewer — it does not comment on style, design, or test coverage. Its only job is to answer, for each AC: did the diff deliver it?

### Configuration

```toml
[ralph]
# Enable per-story verification (default: true)
per_story_verification = true

# Agent for the verifier (default: "" — falls back to default_agent). The bundled
# `story-verifier` subagent sets the system prompt; this config only controls which
# LLM runtime spawns it.
story_verifier_agent = ""
```

Fallback chain: `story_verifier_agent` → `default_agent`.

Stories created before per-story verification existed (no `startCommit`) are skipped — the verifier returns `pass=true` with `skipped=true` so legacy data continues through the normal flow.

## Code Review Pipeline

When all stories are completed, Ralph runs a multi-phase code review pipeline before transitioning to testing. This catches bugs, security issues, and over-engineering early — before they reach QA.

If a PRD returned from testing with failures, the PRD is marked so the next development-complete step skips this full review pipeline for a focused fix cycle.

### Phases

```
All stories complete
  → Extract findings
  → Phase 1: Aggregated Code Review (parallel internal reviewers + optional external reviewer)
  → Phase 1b: Fix agent resolves aggregated blocker findings
  → Phase 2: Targeted Verification Review (critical/major only)
  → Phase 2b: Fix agent resolves remaining blocker findings
  → Non-blocking findings optionally written to review todo file
  → Phase 3: Finalize (optional)
  → Transition to testing
```

### Review Agents

| Agent | Focus | Model |
|-------|-------|-------|
| `quality` | Bugs, security, race conditions, error handling | sonnet |
| `implementation` | Spec compliance, acceptance criteria | opus |
| `testing` | Test coverage, assertion quality, edge cases | sonnet |
| `simplification` | Over-engineering, dead code, unnecessary abstractions | opus |
| `documentation` | Missing/outdated docs, README updates | sonnet |

All review agents are read-only — they cannot modify files. Each agent outputs a structured result:

```xml
<review-result>APPROVE</review-result>
<!-- or -->
<review-result>REQUEST_CHANGES</review-result>
<review-findings>
- [CRITICAL] file.ts:42 - SQL injection in query builder
- [MAJOR] auth.ts:88 - Missing null check on user session
</review-findings>
```

### Fix Loop

Ralph aggregates all first-pass reviewer output before spawning the fix agent. Only CRITICAL and MAJOR findings block the PR and get sent to the fix loop. MINOR findings are treated as follow-ups, and SUGGESTION findings are treated as noise/suggestions.

When reviewers find CRITICAL or MAJOR issues, a fix agent is spawned to resolve them. The review-fix cycle repeats up to `max_fix_iterations` times (default: 3) or until the review is clean.

### Configuration

```toml
[ralph.review]
# Enable/disable the review pipeline (default: true)
enabled = true

# Agent for internal review prompts — quality, implementation, etc. (default: "" — uses default_agent)
agent = "claude-opus"

# Agent for fixing review findings (default: "" — falls back to review.agent → default_agent)
fix_agent = "claude"

# Agent for the finalize step (default: "" — falls back to review.agent → default_agent)
finalize_agent = "claude"

# Agent name from [ralph.agents.*] for external review tool, e.g. codex (default: "" — disabled)
review_agent = "codex"

# Enable finalize step after review (default: false)
finalize_enabled = false

# Custom finalize prompt (optional)
finalize_prompt = "Squash commits and clean up TODO comments."

# Agents for first review pass (default: all 5)
first_review_agents = ["quality", "implementation", "testing", "simplification", "documentation"]

# Agents for second review pass (default: quality + implementation)
second_review_agents = ["quality", "implementation"]

# Max fix iterations per review phase (default: 3)
max_fix_iterations = 3

# Optional markdown file for non-blocking review findings.
# Relative paths resolve from the repo root.
todo_file = ".ralph-review-todo.md"
```

**Fallback chains:**

| Phase | Resolution |
|-------|-----------|
| Internal review | `review.agent` → `default_agent` |
| Fix | `review.fix_agent` → `review.agent` → `default_agent` |
| Finalize | `review.finalize_agent` → `review.agent` → `default_agent` |
| External review | `review.review_agent` (looked up in `[ralph.agents.*]`) |

Verification and docs have their own optional overrides (independent of the review pipeline):

| Phase | Resolution |
|-------|-----------|
| Verification | `verification_agent` → `default_agent` |
| Documentation | `docs.agent` → `default_agent` |

### External Review

Configure a review agent (e.g., codex) to participate in the aggregated first pass:

```toml
[ralph.review]
review_agent = "codex"

[ralph.agents.codex]
command = "npx"
args = ["-y", "@openai/codex", "exec", "-c", "shell_environment_policy.inherit=all", "--dangerously-bypass-approvals-and-sandbox", "-"]
```

The external tool receives a simplified review prompt with the git diff and acceptance criteria. Its output is parsed with the same severity format and aggregated with the internal reviewers before the fix step.

### Grilling (PRD/Spec Cross-Examination)

Grilling is an **opt-in behavior of the `/prd` skill**, not a config flag. When a PRD request mentions "grill" (e.g. "grill this PRD", "write a PRD and grill it"), the skill runs adversarial cross-examination during spec review (step 5) and PRD review (step 9) between the internal reviewer and the external `review_agent`. Each side sees the other's findings and must either **DEFEND** its own (with reasoning) or **WITHDRAW**, and for each opposing finding either **CONCEDE** or **CHALLENGE**. Findings are then classified as:

- **Confirmed** — author defended, opponent conceded or did not challenge. Present to user as a normal finding.
- **Contested** — author defended, opponent challenged. Present to user with both sides' reasoning; user decides.
- **Withdrawn** — author withdrew. Dropped from the actionable list; shown collapsed for transparency.

Requires `[ralph.review].review_agent` to be set. If grilling is requested but no external reviewer is configured, the skill tells you and continues with a single-pass internal review instead. No levels, no persisted flag — say it when you want it, omit it when you don't.

### Review Results

Review results are saved to `<state-dir>/prds/<status>/<prd-name>/review-results/`:

- `first-review.md` — Phase 1 results
- `second-review.md` — Phase 2 results

If `todo_file` is configured, Ralph also maintains a per-PRD section in that markdown file for non-blocking review findings that should be tracked later.

### Disabling Review

```toml
[ralph.review]
enabled = false
```

When disabled, Ralph goes straight from development completion to testing (the original behavior).

### Review skip behavior for fix cycles

When a PRD fails tests (`PRD_FAILED`) and moves back to `in_progress`, Ralph creates a fix story and updates `prd.json` with:

```json
{
  "testsCaughtIssue": true
}
```

That flag tells Ralph to skip the full review pipeline on the next "all stories complete" transition.

## Testing Workflow

When all stories are completed, Ralph automatically:

1. Generates `verification.md` - a checklist of things to test, including documentation checks
2. Moves the PRD to `testing` status

Run automated tests:

```bash
omnidev ralph test my-feature
```

The test agent will:

- Run teardown first (ensure clean state from previous runs)
- Run setup scripts (database reset, seeding)
- Start the dev server
- Wait for health check
- Run project quality checks (lint, typecheck, tests)
- Go through the verification checklist
- Check whether affected files under `docs/**/*.md` were updated
- Try to break the app (edge cases, invalid inputs, etc.)
- Take screenshots of any issues (with Playwriter)
- Save API responses for debugging
- Run teardown scripts (cleanup)

### Test Result Signals

The test agent outputs one of these signals:

**Success:**

```
<test-result>PRD_VERIFIED</test-result>
```

→ PRD automatically moves to `completed`

**Failure:**

```
<test-result>PRD_FAILED</test-result>
<issues>
- Issue description 1
- Issue description 2
</issues>
```

→ Fix story created (FIX-001, FIX-002, etc.), PRD moves back to `in_progress`

That also sets `testsCaughtIssue: true` so the next completion goes directly into testing after implementation.

## Configuration

Configuration lives in `omni.toml` under the `[ralph]` section. If `omni.local.toml` exists in the same directory, Ralph loads it after `omni.toml` and uses it as an override layer:

```toml
[ralph]
project_name = "my-app"       # Required. Slug format: lowercase, hyphens, no leading/trailing hyphens.
default_agent = "claude"
default_iterations = 10
# verification_agent = "claude-opus"  # Optional. Agent for verification generation (default: default_agent)
# per_story_verification = true       # Optional. Run checklist auditor after each story (default: true)
# story_verifier_agent = ""           # Optional. Agent for per-story verifier (default: default_agent)

[ralph.testing]
# Quality checks the agent must run
project_verification_instructions = "Run pnpm lint, pnpm typecheck, and pnpm test."
test_iterations = 5
# Enable web testing with Playwriter MCP
web_testing_enabled = false
# Health check timeout in seconds
health_check_timeout = 120

# Free-form instructions - URLs, credentials, context
instructions = """
URLs:
- App: http://localhost:3000
- Admin: http://localhost:3000/admin
- API: http://localhost:3000/api

Test Users:
- Admin: admin@test.com / testpass123
- User: user@test.com / testpass123

Database is seeded with 10 users, 5 products, sample orders.
"""

[ralph.scripts]
setup = "./scripts/ralph/setup.sh"
start = "./scripts/ralph/start.sh"
health_check = "./scripts/ralph/health-check.sh"
teardown = "./scripts/ralph/teardown.sh"

# [ralph.docs]
# path = "docs"            # Documentation directory (default: "docs"; Ralph expects markdown files under docs/**/*.md)
# auto_update = true        # Safety-net doc update on PRD completion (default: true)
# agent = "claude-opus"     # Optional. Agent for doc updates (default: default_agent)

[ralph.agents.claude]
command = "npx"
args = ["-y", "@anthropic-ai/claude-code", "--model", "sonnet", "--dangerously-skip-permissions", "-p"]

[ralph.agents.codex]
command = "npx"
args = ["-y", "@openai/codex", "exec", "-c", "shell_environment_policy.inherit=all", "--dangerously-bypass-approvals-and-sandbox", "-"]

[ralph.review]
enabled = true
review_agent = ""
max_fix_iterations = 3

[ralph.swarm]
# Relative path to parent directory for worktrees (default: "..")
worktree_parent = ".."
# Max panes per tmux window (default: 4)
panes_per_window = 4
# Seconds before auto-closing a completed pane (default: 30)
pane_close_timeout = 30
# Custom worktree creation command (optional). Placeholders: {name}, {path}, {branch}
# worktree_create_cmd = "wt switch --create --no-cd --yes {name}"
# Agent for merge operations (default: default_agent)
# merge_agent = "claude-opus"
```

## Testing Scripts

Ralph uses lifecycle scripts configured via `[ralph.scripts]`:

| Config Key | Description |
|------------|-------------|
| `setup` | Runs before testing (database reset, seeding) |
| `start` | Starts the dev server in background |
| `health_check` | Polls until ready (exit 0 = ready) |
| `teardown` | Cleanup after testing (stop server) |

Scripts are optional - if not configured, that step is skipped. Place scripts in a version-controlled location (e.g., `scripts/ralph/`).

Scripts receive the **PRD name as `$1`** (optional). Use it for namespaced logs and PIDs:

```bash
PRD_NAME="${1:-default}"  # Use "default" if not provided
LOG_FILE="/tmp/ralph/logs/${PRD_NAME}.log"
PID_FILE="/tmp/ralph/${PRD_NAME}.pid"
```

### Example `start.sh`

Start dev servers in background, tracking PIDs for cleanup:

```bash
#!/usr/bin/env bash
#
# Ralph start script - starts dev servers in background
# Tracks PIDs for cleanup in teardown.sh
# Receives PRD name as $1 for namespaced logs/PIDs

set -e

PRD_NAME="${1:-default}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PID_DIR="/tmp/ralph"
LOG_DIR="/tmp/ralph/logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

cd "$ROOT_DIR"

echo "[ralph:$PRD_NAME] Starting dev servers..."

# Start turbo dev without TUI (--ui stream instead of --ui tui)
# Run in background with nohup to detach from terminal
nohup pnpm turbo run --ui stream --concurrency=15 dev > "$LOG_DIR/${PRD_NAME}.log" 2>&1 &
DEV_PID=$!
echo $DEV_PID > "$PID_DIR/${PRD_NAME}.pid"

echo "[ralph:$PRD_NAME] Started dev server (PID: $DEV_PID)"
echo "[ralph:$PRD_NAME] Logs at: $LOG_DIR/${PRD_NAME}.log"
echo "[ralph:$PRD_NAME] PID stored in: $PID_DIR/${PRD_NAME}.pid"

# Give it a moment to spawn child processes
sleep 2

echo "[ralph:$PRD_NAME] Dev servers starting in background..."
```

### Example `health-check.sh`

```bash
#!/bin/bash
curl -sf http://localhost:3000/api/health > /dev/null
```

### Example `teardown.sh`

Clean up processes using saved PIDs, with graceful and force kill fallbacks:

```bash
#!/usr/bin/env bash
#
# Ralph teardown script - cleanup after testing
# Stops dev servers, optionally destroys docker volumes
# Receives PRD name as $1 for namespaced cleanup

set -e

PRD_NAME="${1:-default}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PID_DIR="/tmp/ralph"
LOG_DIR="/tmp/ralph/logs"
PID_FILE="$PID_DIR/${PRD_NAME}.pid"
LOG_FILE="$LOG_DIR/${PRD_NAME}.log"

cd "$ROOT_DIR"

echo "[ralph:$PRD_NAME] Starting teardown..."

# Kill dev server and all child processes
if [ -f "$PID_FILE" ]; then
    DEV_PID=$(cat "$PID_FILE")
    echo "[ralph:$PRD_NAME] Stopping dev server (PID: $DEV_PID)..."

    # Kill the process group to get all child processes
    pkill -P $DEV_PID 2>/dev/null || true
    kill $DEV_PID 2>/dev/null || true

    # Wait a moment for graceful shutdown
    sleep 2

    # Force kill if still running
    kill -9 $DEV_PID 2>/dev/null || true
    pkill -9 -P $DEV_PID 2>/dev/null || true

    rm -f "$PID_FILE"
    echo "[ralph:$PRD_NAME] Stopped dev server"
fi

# Kill any remaining node processes that might be from our dev servers
# Be careful here - only kill processes in our project directory
pkill -f "node.*myproject.*dev" 2>/dev/null || true

# Stop docker services and remove volumes for clean state
echo "[ralph:$PRD_NAME] Stopping docker services..."
docker compose down -v --remove-orphans 2>/dev/null || true

# Clean up log file for this PRD
if [ -f "$LOG_FILE" ]; then
    echo "[ralph:$PRD_NAME] Cleaning up logs..."
    rm -f "$LOG_FILE"
fi

echo "[ralph:$PRD_NAME] Teardown complete!"
```

## PRD Structure

Each PRD lives in `<state-dir>/prds/<status>/<prd-name>/` with these files:

| File | Description |
|------|-------------|
| `prd.json` | PRD definition with metadata and stories |
| `spec.md` | Detailed feature requirements |
| `progress.txt` | Log of work done (implementation + testing sessions) |
| `verification.md` | Auto-generated test checklist |
| `test-results/` | Test evidence (screenshots, API responses) |
| `review-results/` | Code review findings and fix history |

### test-results/

Created during testing:

```
test-results/
├── report.md           # Main test report
├── screenshots/        # Issue screenshots
│   └── issue-001.png
└── api-responses/      # API test results
    └── endpoint.json
```

## Web Testing with Playwriter

When `web_testing_enabled = true`, the test agent uses Playwriter MCP for browser automation:

```bash
# Create session and isolated page
playwriter session new
playwriter -s 1 -e "state.myPage = await context.newPage()"
playwriter -s 1 -e "await state.myPage.goto('http://localhost:3000')"

# Check page state
playwriter -s 1 -e "console.log(await accessibilitySnapshot({ page: state.myPage }))"

# Take screenshots
playwriter -s 1 -e "await state.myPage.screenshot({ path: 'test-results/screenshots/issue-001.png', scale: 'css' })"
```

## Findings

When completing a PRD, Ralph extracts patterns and learnings into `<state-dir>/findings.md`. This serves as institutional knowledge for the codebase.

## Dependencies

PRDs can depend on other PRDs via the `dependencies` array. A PRD cannot start until all its dependencies are completed.

```json
{
  "name": "user-dashboard",
  "dependencies": ["user-auth", "database-setup"]
}
```

## Full QA Cycle Example

```bash
# 1. Create PRD (via /prd skill or manually)

# 2. Start development
omnidev ralph start my-feature
# Agent implements stories iteratively
# When all stories complete → code review pipeline runs → moves to testing

# 3. Run tests
omnidev ralph test my-feature
# Runs: teardown.sh (clean) → setup.sh → start.sh → health-check.sh → agent tests → teardown.sh

# 4a. If PRD_VERIFIED → automatically completed!

# 4b. If PRD_FAILED → fix story created
omnidev ralph start my-feature  # Fix the issues
# Back to step 3

# 5. View completed PRD findings
# Findings are at $XDG_STATE_HOME/omnidev/ralph/<project>/findings.md

# 6. View review results
# Review results are at $XDG_STATE_HOME/omnidev/ralph/<project>/prds/completed/my-feature/review-results/
```
