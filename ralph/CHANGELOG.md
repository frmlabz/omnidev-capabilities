# Changelog

## 2.1.0 — 2026-04-22

### Added

- **Rich story files** — Each story lives as a single markdown file at `stories/<id>.md` inside the PRD directory, with frontmatter (`id`, `title`, `priority`, `dependencies`) and sections for Goal, Scope, Out of scope, Constraints, Suggested files, Deliverables, and `## Acceptance Criteria`. The story file is the primary artifact the dev agent receives — it replaces the runtime-composed generic prompt. Acceptance criteria are short (3–8 items), code-level, and mechanically checkable against the diff; behavioral checks belong in QA.
- **Per-story verifier as a Ralph-owned orchestration step** — After every `<promise>COMPLETE</promise>` signal, Ralph calls the configured provider variant directly (not a subagent) with the story file content and `git diff <story-start-sha>..HEAD`. The verifier emits `<check id=... status="pass|fail" evidence=.../>` tags and a `<verification-result>PASS|FAIL</verification-result>` signal. On FAIL the story reverts to `in_progress` with failed-check evidence appended as questions; budget is one retry, then auto-block. Prompt lives at `lib/orchestration/verifier-prompt.md`.
- **QA platform plugin system** — Projects declare `[ralph.qa.platforms.<name>]` entries. Each platform may name a capability plugin via `plugin = "<id>"`, which resolves to `$OMNIDEV_CAPABILITIES_ROOT/<id>/ralph-qa.md` and is injected verbatim. The QA session runs in two steps: general pass (instructions + story ACs), then platform plugin pass (only if platforms with plugins are declared). Both must pass for the PRD to reach `completed`. Missing plugin files are hard failures.
- **`ralph migrate` command** — One-way cutover for legacy PRD state under `$XDG_STATE_HOME/omnidev/ralph/`. Renames `prds/testing/` → `prds/qa/`, rewrites `status: "testing"` → `"qa"` and `testsCaughtIssue` → `qaCaughtIssue` in every `prd.json`, converts stories with legacy `acceptanceCriteria: string[]` into `stories/<id>.md` files with a `## Acceptance Criteria` section, writes `promptPath` onto each story, renames `test-results/` → `qa-results/`, and quarantines unmigratable PRD directories to `old/` with a `MIGRATION-REPORT.md`. Idempotent.

### Changed

- **Acceptance criteria source of truth moved to story files** — Runtime code (review prompts, verification checklist generation, per-story verifier) reads `## Acceptance Criteria` from `stories/<id>.md` via `readStoryAcceptanceCriteria()`. The 3k-character spec truncation in dev prompts is removed — the story file is already right-scoped.
- **Agents renamed to provider variants** — `[ralph.agents.X]` sections in `omni.toml` are now `[ralph.provider_variants.X]`. These are Ralph-owned LLM launch profiles (command + args) and do not map to `agent.toml`. The `AgentConfig` type is now `ProviderVariantConfig`. Missing provider variants are hard failures at load time with a message naming the missing key and the setting that referenced it.
- **Testing renamed to QA throughout** — Mechanical rename; no behavioral change. State machine `testing` → `qa`, `lib/testing.ts` → `lib/qa.ts`, `runTesting()` → `runQA()`, `generateTestPrompt()` → `generateQAPrompt()`, signal `<test-result>` → `<qa-result>` (with `PRD_FAILED` → `QA_FAILED`), directory `test-results/` → `qa-results/`, CLI `ralph test <prd>` → `ralph qa <prd>`, PRD field `testsCaughtIssue` → `qaCaughtIssue`, event `test_complete` → `qa_complete`, status emoji `🔶` → `🟣`.

### Breaking Changes

#### 1. `[ralph.agents.*]` → `[ralph.provider_variants.*]` and associated config key renames

All Ralph config keys that selected an LLM launch profile were renamed to use `provider_variant` terminology, and the section name in `omni.toml` changed:

| Before | After |
|--------|-------|
| `[ralph.agents.claude-opus]` | `[ralph.provider_variants.claude-opus]` |
| `default_agent` | `default_provider_variant` |
| `verification_agent` | `verification_provider_variant` |
| `story_verifier_agent` | `[ralph.verification].story_verifier_provider_variant` |
| `[ralph.review].agent` | `[ralph.review].provider_variant` |
| `[ralph.review].fix_agent` | `[ralph.review].fix_provider_variant` |
| `[ralph.review].finalize_agent` | `[ralph.review].finalize_provider_variant` |
| `[ralph.review].review_agent` | `[ralph.review].review_provider_variant` |
| `[ralph.docs].agent` | `[ralph.docs].provider_variant` |
| `[ralph.swarm].merge_agent` | `[ralph.swarm].merge_provider_variant` |

`agent.toml` remains owned exclusively by Claude/Codex subagent systems and no longer governs Ralph orchestration steps, the story verifier, provider selection, or QA plugins. The `--agent` CLI flag is now `--provider-variant`.

#### 2. Story shape: `acceptanceCriteria` dropped, `promptPath` added

`prd.json` story records no longer carry `acceptanceCriteria: string[]`. They now carry `promptPath: "stories/<id>.md"`; the story file is the source of truth for scope, deliverables, and acceptance criteria. Runtime code has no legacy fallback — an unmigrated PRD will fail at runtime. Story files missing a `## Acceptance Criteria` section are a hard failure.

#### 3. `testing` → `qa` across state, config, CLI, and signals

| Area | Before | After |
|------|--------|-------|
| PRD status | `testing` | `qa` |
| Status directory | `prds/testing/` | `prds/qa/` |
| CLI command | `omnidev ralph test <prd>` | `omnidev ralph qa <prd>` |
| Swarm subcommand | `ralph swarm test <prd>` | `ralph swarm qa <prd>` |
| Config section | `[ralph.testing]` | `[ralph.qa]` |
| Config key | `test_iterations` | `qa_iterations` |
| Config key | `web_testing_enabled` | removed (replaced by `[ralph.qa.platforms.*]`) |
| PRD field | `testsCaughtIssue` | `qaCaughtIssue` |
| Per-PRD results dir | `test-results/` | `qa-results/` |
| Signal (pass) | `<test-result>PRD_VERIFIED</test-result>` | `<qa-result>PRD_VERIFIED</qa-result>` |
| Signal (fail) | `<test-result>PRD_FAILED</test-result>` | `<qa-result>QA_FAILED</qa-result>` |
| Source file | `lib/testing.ts` | `lib/qa.ts` |
| Exported fn | `runTesting`, `generateTestPrompt` | `runQA`, `generateQAPrompt` |
| Engine event | `test_complete` | `qa_complete` |

No aliases are provided. Update scripts, hooks, and anything parsing PRD state.

### Migration Guide

`ralph migrate` handles the state-side cutover. Config and scripts must still be updated by hand.

1. **Update `omni.toml`** — rename every `[ralph.agents.X]` to `[ralph.provider_variants.X]` and rename each config key per the breaking-changes table above:

   ```diff
    [ralph]
    project_name = "my-app"
   -default_agent = "claude-opus"
   -verification_agent = "claude-haiku"
   +default_provider_variant = "claude-opus"
   +verification_provider_variant = "claude-haiku"

   -[ralph.agents.claude-opus]
   +[ralph.provider_variants.claude-opus]
    command = "claude"
    args = ["--model", "claude-opus-4-7", "--print"]

    [ralph.review]
   -agent = "claude-opus"
   -fix_agent = "claude-opus"
   -finalize_agent = "claude-opus"
   -review_agent = "codex-high"
   +provider_variant = "claude-opus"
   +fix_provider_variant = "claude-opus"
   +finalize_provider_variant = "claude-opus"
   +review_provider_variant = "codex-high"

    [ralph.docs]
   -agent = "claude-opus"
   +provider_variant = "claude-opus"

    [ralph.swarm]
   -merge_agent = "claude-opus"
   +merge_provider_variant = "claude-opus"
   ```

2. **Replace `[ralph.testing]` with `[ralph.qa]`** — and declare platforms if QA needs a plugin:

   ```diff
   -[ralph.testing]
   -test_iterations = 3
   -web_testing_enabled = true
   +[ralph.qa]
   +qa_iterations = 3
   +instructions = """
   +Free-text QA instructions: how to bring up services, what flows to exercise.
   +"""
   +
   +[ralph.qa.platforms.web]
   +plugin = "browser-testing"
   +
   +[ralph.qa.platforms.api]
   +# no plugin — LLM uses instructions + story acceptance criteria
   ```

3. **Opt in to the per-story verifier (optional, defaults apply)** — the verifier runs by default with `claude-haiku`. To override:

   ```toml
   [ralph.verification]
   story_verifier_provider_variant = "claude-haiku"
   ```

4. **Run the state migration:**

   ```bash
   omnidev ralph migrate
   ```

   This renames `prds/testing/` → `prds/qa/`, rewrites PRD JSON (`status`, `testsCaughtIssue`), writes `stories/<id>.md` files for every legacy story, drops `acceptanceCriteria` from `prd.json`, and renames `test-results/` → `qa-results/`. Review the printed report; any quarantined PRDs now live under `<state-root>/<project>/old/` with a `MIGRATION-REPORT.md` explaining why.

5. **Review and edit each generated story file** — `ralph migrate` writes a stub with the legacy ACs under `## Acceptance Criteria` and placeholder content for the other sections. Before running Ralph against a migrated PRD, fill in Goal, Scope, Out of scope, Constraints, Suggested files, and Deliverables so the dev agent has a right-scoped prompt.

6. **Update scripts and CI** — replace:
   - `omnidev ralph test <prd>` → `omnidev ralph qa <prd>`
   - `omnidev ralph swarm test <prd>` → `omnidev ralph swarm qa <prd>`
   - `--agent <name>` → `--provider-variant <name>`
   - Anything that reads `testsCaughtIssue`, `status == "testing"`, `test-results/`, `<test-result>` signals, or `[ralph.agents.*]`.

7. **Declare QA plugins** (optional) — if a capability ships a `ralph-qa.md` (e.g. `browser-testing`), point a platform at it via `[ralph.qa.platforms.<name>] plugin = "<capability-id>"`. Ralph resolves `$OMNIDEV_CAPABILITIES_ROOT/<capability-id>/ralph-qa.md`; a missing file is a hard failure.

There is no runtime fallback for legacy `acceptanceCriteria` arrays or `"testing"` status. Un-migrated PRDs will fail at load.

## 2.0.0 — 2026-04-21

### Added

- **Per-story verification** — After the dev agent signals a story complete, Ralph runs a cheap checklist auditor (`story-verifier` subagent) against that story's git diff and acceptance criteria. One FAIL reverts the story to `in_progress` with the failed ACs appended as questions; a second FAIL blocks it. Controlled by top-level `per_story_verification` (default `true`) and `story_verifier_agent` (falls back to `default_agent`) under `[ralph]`. New `Story.startCommit` and `Story.verificationAttempts` fields persist per-story verifier state. Emits two new engine events: `story_verification_start` and `story_verification_complete`.
- **Grilling (PRD/spec cross-examination)** — Opt-in adversarial debate between internal `spec-reviewer`/`prd-reviewer` subagents and the external `review_agent` (codex) during `/prd` skill execution. Triggered by the user mentioning "grill" in the PRD request (e.g. "grill this PRD") — there is no config flag. Each side sees the other's findings and must DEFEND/WITHDRAW its own or CONCEDE/CHALLENGE the opponent's; findings are classified as confirmed, contested, or withdrawn. Requires `[ralph.review].review_agent` to be set; otherwise the skill warns and continues with a single-pass internal review. Consumed by the `/prd` skill only — the code review pipeline is unaffected.
- **Aggregated review pass + review TODO file** — The first review pass now aggregates all specialized reviewers plus the optional external reviewer before triggering fixes, reducing serial review churn. New `[ralph.review].todo_file` lets Ralph persist non-blocking review findings to a markdown TODO file so follow-ups and suggestions do not get lost.
- **Auto-commit after PRD verification** — When a PRD is verified, the engine now spawns the default agent to commit any uncommitted changes (documentation updates, config, etc.) using the ralph commit format. Best-effort — failures log a warning and do not block completion.
- **Swarm merge agent config** — New `merge_agent` field under `[ralph.swarm]` allows routing merge operations to a specific agent. Resolution: `--agent` flag → `swarm.merge_agent` → `default_agent`. Existing configs with no new fields produce identical behavior.
- **Per-phase agent configuration for verification and docs** — New `verification_agent` field under `[ralph]` and `agent` field under `[ralph.docs]` allow routing verification generation and documentation updates to different LLM agents. Both fall back independently to `default_agent` (no chain through `review.agent`). Existing configs with no new fields produce identical behavior.
- **Per-phase agent configuration for review pipeline** — New `[ralph.review]` fields `agent`, `fix_agent`, and `finalize_agent` allow routing each review phase to a different LLM agent. Fallback chain: `fix_agent` → `agent` → `default_agent`, `finalize_agent` → `agent` → `default_agent`. Existing configs with no new fields produce identical behavior.
- **Custom worktree creation command** — `[ralph.swarm] worktree_create_cmd` allows using a custom tool (e.g., `wt switch -c {name}`) instead of the default `git worktree add`. The command runs inside the tmux pane. Placeholders: `{name}`, `{path}`, `{branch}`.
- **Internal rename: runner → swarm, AgentRunner → AgentExecutor** — All internal code now uses `swarm` (matching the CLI sub-command) instead of `runner`. The `AgentRunner` class (which spawns individual agent processes) is renamed to `AgentExecutor` to avoid ambiguity. Config key changed from `[ralph.runner]` to `[ralph.swarm]`. State file changed from `runner.json` to `swarm.json`.
- **Skip full review on focused fix cycles** — Added `testsCaughtIssue` PRD metadata. When testing fails (`PRD_FAILED`) and a fix story is created, the next `handleDevelopmentComplete` pass now skips the full review pipeline and goes directly to verification/testing to avoid repeated review overhead for targeted fix work.

### Fixed

- **Swarm custom worktree command safety** — `swarm start` now always `cd`s into the resolved worktree path and verifies the expected branch before launching `omnidev ralph start`. This prevents accidental execution on the main worktree when custom commands cannot persist shell directory changes (for example `wt switch` without shell integration).
- **Suppress Worktrunk shell-integration prompt in swarm panes** — When `worktree_create_cmd` starts with `wt`, swarm now sets `WORKTRUNK_SKIP_SHELL_INTEGRATION_PROMPT=true` automatically so `swarm start` does not block on interactive `Install shell integration?` prompts.

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
