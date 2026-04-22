# Ralph 2.1 — Rich Stories, Story Verifier, QA Phase, Plugin System

## Overview

Ralph 2.1 ships interconnected improvements: stories become self-contained files with acceptance criteria that the engine can verify; per-story verification runs automatically after each development run completes; the testing phase is renamed QA throughout; projects can declare QA plugins that inject capability-specific instructions into the QA session; Ralph LLM launch profiles are renamed provider variants; and legacy PRDs are handled by an explicit migration command rather than runtime fallbacks.

## Goals

- Replace the thin `acceptanceCriteria: string[]` story model with pre-authored, self-contained story files that carry the full instructional and acceptance criteria weight
- Add per-story code-level verification that runs after each development run completes, before the engine picks the next story
- Rename `testing` to `qa` everywhere — state machine, config, CLI, file paths, prompt signals
- Let projects declare QA platforms and optional plugins; capabilities inject their own QA instructions via a plain markdown file convention
- Rename Ralph's LLM launch profiles from agents to provider variants to avoid confusion with Claude/Codex subagents

## Non-Goals

- Per-story QA (QA stays PRD-level, fires once after all stories pass review)
- Capability dependency resolution in omnidev sync (ralph reads a plugin name, looks it up, fails loud if absent)
- Runtime backwards-compat shims for old story format or old `testing` state (`ralph migrate` handles the cut before runtime)
- Changing spec.md structure (spec.md stays as-is — high-level design doc, no story index)
- Changing the review pipeline or grilling protocol

## Principles

- One progress.txt per PRD, shared across all stories — each story's development run sees what prior stories built
- Subagents (under `subagents/`) are what an LLM spawns; Ralph-spawned LLM processes use provider variants from omni.toml + Ralph-owned prompt files, not `agent.toml`
- `[ralph.provider_variants.X]` entries in omni.toml are Ralph-owned LLM launch profiles (command + args); this replaces the old `[ralph.agents.X]` naming to avoid collision with Claude/Codex subagents
- `agent.toml` belongs only to Claude/Codex subagent definitions. It does not define Ralph orchestration steps, story verifiers, provider selection, or QA plugins.
- Plugin content is a plain markdown file the capability ships; ralph injects it verbatim

## Requirements

### FR-1: Rich Story File Format

Each story lives as a single markdown file at `stories/<id>.md` inside the PRD directory. The story file is the primary artifact the dev agent receives; it replaces the runtime-composed generic prompt.

**File structure:**

```markdown
---
id: S-01
title: Short descriptive title
priority: 1
dependencies: []
---

## Goal
Single paragraph: what this story accomplishes and why.

## Scope
Bulleted list of what is in scope. File paths, component names, config keys.

## Out of scope
Bulleted list of explicit exclusions. Prevents scope creep during implementation.

## Constraints
Codebase-level rules: DI conventions, import paths, no specific libraries, etc.

## Suggested files
Files the agent should read or modify. Not exhaustive — signals where to start.

## Deliverables
Numbered list of concrete outputs. Each deliverable is individually checkable.

## Acceptance Criteria
- [ ] Checkable code-level item (e.g. "No references to `src/i18n/v1` under `apps/`")
- [ ] Static assertion (e.g. "All keys in en.json present in sr.json")
- [ ] Build/typecheck assertion (e.g. "`pnpm typecheck` passes in touched packages")
```

The `## Acceptance Criteria` section is short (3–8 items), code-level, and mechanically checkable against the diff. Behavioral checks belong in the QA phase.

**prd.json story record** retains `id`, `title`, `status`, `priority`, `questions`, and adds `promptPath: "stories/S-01.md"`. The `acceptanceCriteria` field is dropped from prd.json — the story file is the source of truth. CLI shows the story file path; the user reads it directly.

**prompt.ts** rewrite: `generatePrompt()` reads the story's `promptPath` file verbatim, prepends a minimal header (PRD name, story id, link to spec.md, last 20 lines of progress.txt). The 3k-char spec truncation is removed — story files are already right-scoped.

### FR-2: Per-Story Verifier

After each development run signals `<promise>COMPLETE</promise>`, the engine runs the story verifier before advancing to the next story. This is a Ralph-owned orchestration step, not a subagent — Ralph calls the configured provider variant directly.

**Definition:** prompt lives in `lib/orchestration/verifier-prompt.md` (or `.ts`). Config in omni.toml:

```toml
[ralph.verification]
story_verifier_provider_variant = "claude-haiku"   # references [ralph.provider_variants.claude-haiku]
```

Defaults to `claude-haiku` if not configured. If the referenced provider variant is absent, Ralph fails before running the verifier.

**Inputs:**
- Full content of the story file (`stories/<id>.md`) — verifier extracts `## Acceptance Criteria`
- `git diff <story-start-sha>..HEAD` — the actual code change

**Output signal:**
```xml
<check id="1" status="pass" evidence="..."/>
<check id="2" status="fail" evidence="..."/>
<verification-result>PASS|FAIL</verification-result>
```

**On PASS:** engine marks the story completed, appends outcome to progress.txt, moves to next story.

**On FAIL:** story goes back to `in_progress`; failed check evidence appended as questions on the story object in prd.json; dev agent runs again with the failure context visible in progress.txt. Budget: 1 retry, then auto-block.

### FR-3: Ralph Provider Variants

**Rename `[ralph.agents.X]` → `[ralph.provider_variants.X]`** throughout omni.toml and config loader. A provider variant is a Ralph-owned spawnable LLM launch profile:

```toml
[ralph.provider_variants.claude-opus]
command = "claude"
args = ["--model", "claude-opus-4-7", "--print"]

[ralph.provider_variants.claude-haiku]
command = "claude"
args = ["--model", "claude-haiku-4-5-20251001", "--print"]

[ralph.provider_variants.codex-high]
command = "codex"
args = ["exec"]
```

Provider variant names are referenced by Ralph config keys that select an LLM launch profile. Existing Ralph config keys with `agent` naming are renamed for clarity:

- `default_agent` → `default_provider_variant`
- `verification_agent` → `verification_provider_variant`
- `story_verifier_agent` → `[ralph.verification].story_verifier_provider_variant`
- `[ralph.review].agent` → `[ralph.review].provider_variant`
- `[ralph.review].fix_agent` → `[ralph.review].fix_provider_variant`
- `[ralph.review].finalize_agent` → `[ralph.review].finalize_provider_variant`
- `[ralph.review].review_agent` → `[ralph.review].review_provider_variant`
- `[ralph.docs].agent` → `[ralph.docs].provider_variant`

These names do not map to `agent.toml`.

Ralph must not inspect `subagents/*/agent.toml` for provider selection. `agent.toml` remains owned by Claude/Codex subagent systems and describes subagent prompt/model/tool/permission settings inside those tools only.

Missing provider variants are hard failures. Config validation should name the missing key and the setting that referenced it.

### FR-4: Rename Testing → QA

Mechanical rename. No behavior changes.

**State machine:** `testing` → `qa`. Transition: `in_progress → qa → completed`. `state-machine.ts` updated.

**Config keys:**
- `[ralph.testing]` → `[ralph.qa]`
- `web_testing_enabled` removed (replaced by platform declarations in FR-5)
- `test_iterations` → `qa_iterations`

**Code:** `lib/testing.ts` → `lib/qa.ts`. `runTesting()` → `runQA()`. `generateTestPrompt()` → `generateQAPrompt()`.

**Signals:** `<test-result>PRD_VERIFIED</test-result>` → `<qa-result>PRD_VERIFIED</qa-result>`. `<test-result>PRD_FAILED</test-result>` → `<qa-result>QA_FAILED</qa-result>`.

**File paths:** `test-results/` → `qa-results/`.

**CLI:** `ralph test <prd>` → `ralph qa <prd>`.

**prd.json fields:** `testsCaughtIssue` → `qaCaughtIssue`.

**Migration command:** `ralph migrate` performs the one-way cutover. It renames `test-results/` → `qa-results/`; rewrites `status: "testing"` → `status: "qa"` in all prd.json files found under `$XDG_STATE_HOME/omnidev/ralph/`; converts story records with legacy `acceptanceCriteria` arrays into `stories/<id>.md` files; writes `promptPath` onto each story; removes `acceptanceCriteria` from prd.json; and moves any unconvertible legacy PRD directory to an `old/` location with a clear migration report. Runtime code does not support unmigrated PRDs.

### FR-5: QA Platform Plugin System

Projects declare which platforms need QA. Each platform optionally names a capability plugin. The QA session runs in two steps: general pass first, then platform plugins.

**omni.toml:**

```toml
[ralph.qa]
instructions = """
Free-text QA instructions: how to bring up services, what flows to exercise, manual steps.
"""

[ralph.qa.platforms.web]
plugin = "browser-testing"   # capability id; omit if no plugin needed

[ralph.qa.platforms.api]
# no plugin — LLM uses instructions + story acceptance criteria
```

**Plugin resolution:** for each platform with `plugin = "<id>"`, look up `$OMNIDEV_CAPABILITIES_ROOT/<id>/ralph-qa.md`. Fail loud if the capability dir is absent or if the file doesn't exist inside it.

**QA prompt composition (two-step):**

Step 1 — general pass:
```
[PRD name + link to spec.md]
[## Story acceptance criteria — concatenated ## Acceptance Criteria sections from all completed stories]
[ralph.qa].instructions
Signal: <qa-result>PRD_VERIFIED</qa-result> or <qa-result>QA_FAILED</qa-result>
```

Step 2 — plugin pass (only if platforms with plugins are declared):
```
[PRD name]
[Summary of step 1 outcome]
[## Platform: web (via browser-testing)]
<verbatim content of browser-testing/ralph-qa.md>
[## Platform: api — no plugin, skip]
Signal: <qa-result>PRD_VERIFIED</qa-result> or <qa-result>QA_FAILED</qa-result>
```

Both steps must pass for the PRD to move to `completed`. Step 2 is skipped entirely if no platforms declare a plugin.

### FR-6: browser-testing Capability Adds ralph-qa.md

`frmlabztools/capabilities/browser-testing/ralph-qa.md`:

```markdown
This project uses Playwriter for browser QA.

Use the Playwriter skill workflow:
1. `/playwriter:plan` — create a plan under `plans/playwriter/<prd-name>/plan.md`. Wait for user approval.
2. `/playwriter:run` — spawn Sonnet subagents per test group; write `findings.md`.
3. `/playwriter:snippet` / `/playwriter:journey` — persist reusable patterns.

Detect $PLAYWRITER_ROOT by probing for a `playwriter/` directory from the project root.
Never hardcode ports, container names, URLs, or credentials — resolve from env or docker compose at runtime.
The story acceptance criteria sections above list the code-level checks already verified; focus the Playwriter journey on the end-to-end flows in the browser.
```

This file lives in the frmlabztools repo, not in the ralph capability.

## Edge Cases

- **Story file missing at runtime:** hard failure. The PRD must be migrated before Ralph can run it.
- **Acceptance criteria section absent from story file:** hard failure. Story files must include mechanically checkable `## Acceptance Criteria`.
- **Plugin capability installed but ralph-qa.md absent:** hard failure. Not a soft degradation.
- **Configured provider variant missing:** hard failure at load time with a clear message naming the missing `[ralph.provider_variants.<name>]` entry and the setting that referenced it.
- **Both `test-results/` and `qa-results/` exist after migration:** warn and leave both; do not auto-delete.
- **Legacy PRD cannot be migrated:** move it to `old/`, leave a migration report explaining why, and do not expose it to normal Ralph runtime commands.

## Success Gate

- `ralph qa <prd>` runs where `ralph test <prd>` used to
- Creating a new PRD via prd-creation skill produces `stories/S-NN.md` files with `## Acceptance Criteria` sections; prd.json stories carry `promptPath` but no `acceptanceCriteria` field
- After a development run signals COMPLETE, the verifier runs automatically; FAIL loops the story back
- `[ralph.qa.platforms.web] plugin = "browser-testing"` causes browser-testing's `ralph-qa.md` to appear in QA step 2
- `[ralph.verification].story_verifier_provider_variant` selects the Ralph provider variant used by the story verifier
- Runtime code has no legacy fallback path for prd.json `acceptanceCriteria` or `testing` status
- All existing PRDs either run without errors after `ralph migrate` or are moved to `old/` with a migration report
