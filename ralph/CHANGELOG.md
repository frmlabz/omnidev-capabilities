# Changelog

## Unreleased

### Added

- **Per-phase agent configuration for review pipeline** — New `[ralph.review]` fields `agent`, `fix_agent`, and `finalize_agent` allow routing each review phase to a different LLM agent. Fallback chain: `fix_agent` → `agent` → `default_agent`, `finalize_agent` → `agent` → `default_agent`. Existing configs with no new fields produce identical behavior.
- **Custom worktree creation command** — `[ralph.swarm] worktree_create_cmd` allows using a custom tool (e.g., `wt switch -c {name}`) instead of the default `git worktree add`. The command runs inside the tmux pane, so tools that CD the shell work correctly. Placeholders: `{name}`, `{path}`, `{branch}`.
- **Internal rename: runner → swarm, AgentRunner → AgentExecutor** — All internal code now uses `swarm` (matching the CLI sub-command) instead of `runner`. The `AgentRunner` class (which spawns individual agent processes) is renamed to `AgentExecutor` to avoid ambiguity. Config key changed from `[ralph.runner]` to `[ralph.swarm]`. State file changed from `runner.json` to `swarm.json`.

### Breaking Changes

#### 1. `run` renamed to `swarm`

The `ralph run` sub-command for tmux-based parallel execution has been renamed to `ralph swarm`.

| Before | After |
|--------|-------|
| `omnidev ralph run start <prd>` | `omnidev ralph swarm start <prd>` |
| `omnidev ralph run stop <prd>` | `omnidev ralph swarm stop <prd>` |
| `omnidev ralph run list` | `omnidev ralph swarm list` |
| `omnidev ralph run attach <prd>` | `omnidev ralph swarm attach <prd>` |
| `omnidev ralph run logs <prd>` | `omnidev ralph swarm logs <prd>` |
| `omnidev ralph run merge <prd>` | `omnidev ralph swarm merge <prd>` |
| `omnidev ralph run cleanup <prd>` | `omnidev ralph swarm cleanup <prd>` |
| `omnidev ralph run recover` | `omnidev ralph swarm recover` |
| `omnidev ralph run conflicts <prd>` | `omnidev ralph swarm conflicts <prd>` |

No alias is provided. Update any scripts or automation that reference the old `run` sub-command.

#### 2. State moved from in-repo to XDG

PRD state has moved from `.omni/state/ralph/` (inside the repository) to `$XDG_STATE_HOME/omnidev/ralph/<project-key>/` (defaults to `~/.local/state/omnidev/ralph/<project-key>/`).

The `<project-key>` is derived as `<project_name>-<hash>`, where `<hash>` is the first 8 hex characters of SHA-256 of the absolute repo root path. This means the same project checked out at different paths gets separate state.

**`project_name` is now required** in `omni.toml`:

```toml
[ralph]
project_name = "my-app"   # slug format: ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$, max 64 chars
```

State is no longer tracked in git. The `ralph/` entry has been removed from gitignore since there is nothing to ignore in-repo.

### Migration Guide

There is no automatic migration. Follow these steps:

1. **Add `project_name` to config** — open `omni.toml` and add `project_name` under `[ralph]`:

   ```toml
   [ralph]
   project_name = "my-app"
   ```

   The name must be a slug: lowercase alphanumeric and hyphens, no leading/trailing hyphens, 1-64 characters.

2. **Run sync** to create the new directory structure:

   ```bash
   omnidev sync
   ```

   This creates the XDG state directories at `~/.local/state/omnidev/ralph/<project_name>-<hash>/prds/{pending,in_progress,testing,completed}/`.

3. **Move existing PRDs** from the old location to the new one:

   ```bash
   # Find your new state dir
   STATE_DIR=$(echo -n "$(git rev-parse --show-toplevel)" | sha256sum | cut -c1-8)
   NEW_DIR="$HOME/.local/state/omnidev/ralph/my-app-$STATE_DIR/prds"

   # Copy PRDs from old location
   cp -r .omni/state/ralph/prds/pending/* "$NEW_DIR/pending/" 2>/dev/null
   cp -r .omni/state/ralph/prds/in_progress/* "$NEW_DIR/in_progress/" 2>/dev/null
   cp -r .omni/state/ralph/prds/testing/* "$NEW_DIR/testing/" 2>/dev/null
   cp -r .omni/state/ralph/prds/completed/* "$NEW_DIR/completed/" 2>/dev/null
   ```

4. **Clean up old state** once verified:

   ```bash
   rm -rf .omni/state/ralph
   ```

5. **Update scripts** — replace any `ralph run` invocations with `ralph swarm`.

6. **Update CI/automation** — if anything reads from `.omni/state/ralph/`, update it to use the new XDG path or CLI commands (`omnidev ralph list`, `omnidev ralph status`, etc.).

### Other Changes

- Added `lib/core/paths.ts` — single source of truth for all state path resolution
- All state file writes now use atomic write (tmp + rename) to prevent partial reads
- Removed `getEngine()` singleton — use `createEngine()` with explicit `projectName`/`repoRoot`
- Removed `migrateToStatusFolders()`, `needsMigration()`, `isStateTracked()` — no migration support
- All state functions now take `projectName` and `repoRoot` as parameters instead of deriving paths from `process.cwd()`
