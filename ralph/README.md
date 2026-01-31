# Ralph - PRD-Driven Development Orchestrator

Ralph automates feature development by breaking PRDs (Product Requirements Documents) into stories and orchestrating AI agents to implement them iteratively. It includes a full QA feedback loop with automated testing.

## Getting Started

Ralph is a capability for [OmniDev](https://github.com/frmlabz/omnidev). Install OmniDev first, then run:

```bash
omnidev init
omnidev add cap --github frmlabz/omnidev-capabilities --path ralph
omnidev sync
```

This creates the Ralph directory structure at `.omni/state/ralph/`.

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
2. **All stories complete** → PRD moves to `testing`, verification.md auto-generated
3. **Tests pass (PRD_VERIFIED)** → PRD moves to `completed`, findings extracted
4. **Tests fail (PRD_FAILED)** → Fix story created, PRD moves back to `in_progress`

## Testing Workflow

When all stories are completed, Ralph automatically:
1. Generates `verification.md` - a checklist of things to test
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

## Configuration

Configuration lives in `omni.toml` under the `[ralph]` section:

```toml
[ralph]
default_agent = "claude"
default_iterations = 10

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

[ralph.agents.claude]
command = "npx"
args = ["-y", "@anthropic-ai/claude-code", "--model", "sonnet", "--dangerously-skip-permissions", "-p"]

[ralph.agents.codex]
command = "npx"
args = ["-y", "@openai/codex", "exec", "-c", "shell_environment_policy.inherit=all", "--dangerously-bypass-approvals-and-sandbox", "-"]
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

Each PRD lives in `.omni/state/ralph/prds/<status>/<prd-name>/` with these files:

| File | Description |
|------|-------------|
| `prd.json` | PRD definition with metadata and stories |
| `spec.md` | Detailed feature requirements |
| `progress.txt` | Log of work done (implementation + testing sessions) |
| `verification.md` | Auto-generated test checklist |
| `test-results/` | Test evidence (screenshots, API responses) |

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

When completing a PRD, Ralph extracts patterns and learnings into `.omni/state/ralph/findings.md`. This serves as institutional knowledge for the codebase.

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
# When all stories complete → moves to testing

# 3. Run tests
omnidev ralph test my-feature
# Runs: teardown.sh (clean) → setup.sh → start.sh → health-check.sh → agent tests → teardown.sh

# 4a. If PRD_VERIFIED → automatically completed!

# 4b. If PRD_FAILED → fix story created
omnidev ralph start my-feature  # Fix the issues
# Back to step 3

# 5. View completed PRD findings
cat .omni/state/ralph/findings.md
```
