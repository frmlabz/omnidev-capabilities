# RALPH CAPABILITY

**Generated:** 2026-02-20T00:00:00
**Commit:** (not specified)
**Branch:** (not specified)

## OVERVIEW
PRD-driven AI agent orchestrator for iterative feature development.

## STRUCTURE
```
ralph/
├── index.ts              # Capability export (cliCommands, sync, gitignore)
├── cli.ts                # Stricli routes (list, status, start, progress)
├── sync.ts               # Directory setup, config.toml creation
├── lib/
│   ├── index.ts          # Library barrel exports
│   ├── types.ts          # TypeScript interfaces (PRD, Story, ReviewConfig, etc.)
│   ├── schemas.ts        # Zod validation schemas
│   ├── results.ts        # Result<T> type, ErrorCodes
│   ├── api.ts            # High-level API (getPRDState, startDevelopment, etc.)
│   ├── events.ts         # Event-based Orchestrator class
│   ├── state.ts          # Legacy state management functions
│   ├── orchestrator.ts   # Legacy orchestrator (backward compat)
│   ├── prompt.ts         # Agent prompt generation from PRD context
│   ├── review-prompt.ts  # Review/fix/finalize prompt generation + findings parser
│   ├── testing.ts        # QA/testing automation
│   ├── verification.ts   # Verification checklist generation
│   ├── documentation.ts  # Doc update utilities
│   ├── core/
│   │   ├── paths.ts      # XDG state path resolution, atomicWrite
│   │   ├── config.ts     # Config loader (smol-toml, getReviewConfig)
│   │   ├── logger.ts     # Logger with multiple outputs
│   │   ├── prd-store.ts  # PRDStore class (CRUD + transitions)
│   │   └── state-machine.ts  # State machines: PRD, Story, Display
│   ├── swarm/
│   │   ├── index.ts      # Swarm barrel exports
│   │   ├── types.ts      # SwarmConfig, SwarmState, SessionBackend, etc.
│   │   ├── state.ts      # swarm.json persistence (loadSwarmState, saveSwarmState)
│   │   ├── swarm.ts      # SwarmManager class (main API)
│   │   ├── worktree.ts   # Git worktree operations
│   │   └── session-tmux.ts   # TmuxSessionBackend implementation
│   └── orchestration/
│       ├── engine.ts     # OrchestrationEngine class (main loop)
│       ├── agent-runner.ts   # AgentExecutor class (spawns agents)
│       └── review-engine.ts  # ReviewEngine class (multi-phase review pipeline)
├── subagents/
│   ├── architect.md      # Opus, read-only, strategic analysis
│   ├── code-reviewer.md  # Opus, read-only, two-stage review
│   ├── explore.md        # Haiku, read-only, codebase search
│   ├── prd-reviewer.md   # Sonnet, read-only, PRD review (spec + stories)
│   ├── spec-reviewer.md  # Sonnet, read-only, spec-only review (pre-stories)
│   ├── research.md       # Sonnet, read-only, external docs
│   └── review/           # Review pipeline agents
│       ├── quality.md        # Sonnet, bugs/security/error handling
│       ├── implementation.md # Sonnet, spec compliance
│       ├── testing.md        # Sonnet, test coverage/quality
│       ├── simplification.md # Sonnet, over-engineering/dead code
│       └── documentation.md  # Haiku, missing/outdated docs
└── skills/
    └── prd-creation/
        └── SKILL.md      # PRD generation workflow
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| State paths | lib/core/paths.ts | XDG path resolution, project key, atomicWrite |
| Config loading | lib/core/config.ts | smol-toml based, getReviewConfig() fills defaults |
| Agent spawning | lib/orchestration/agent-runner.ts | AgentExecutor class with stream-json parsing |
| Iteration logic | lib/orchestration/engine.ts | OrchestrationEngine.runDevelopment() |
| Review pipeline | lib/orchestration/review-engine.ts | ReviewEngine.runReview(), 4-phase pipeline |
| Review prompts | lib/review-prompt.ts | generateReviewPrompt, parseReviewResult, etc. |
| PRD CRUD | lib/core/prd-store.ts | PRDStore class with Zod validation |
| State management | lib/state.ts | Legacy functions (backward compat) |
| Progress tracking | lib/state.ts | appendProgress, getProgress |
| CLI commands | cli.ts | Stricli buildCommand for ralph routes |
| Prompt template | lib/prompt.ts | Generates context-aware agent prompts |
| Testing | lib/orchestration/engine.ts | OrchestrationEngine.runTesting() |

## CONVENTIONS

**Ralph-Specific:**
- Config via smol-toml in lib/core/config.ts
- Custom commit format: `feat: [<story-id>] - <title>`
- Progress.txt appends — never replaces existing content
- Codebase patterns extracted from progress.txt "## Codebase Patterns" section
- One story per iteration — enforced by getNextStory() priority sorting
- Before writing new code, check how similar modules are structured and follow the same pattern (export patterns, manifest files, config conventions)
- After creating or updating a PRD, run the prd-reviewer automatically — do not wait for the user to ask
- All FR numbers, story IDs, and priority numbers must be sequential and unique — no duplicates after any renumbering

**Review Pipeline:**
- Review runs automatically between development completion and testing transition
- Enabled by default; disable with `[ralph.review] enabled = false`
- Review agents are read-only (disallowedTools: Write, Edit) — only the fix agent can modify code
- External review (codex, etc.) reuses agent config from `[ralph.agents.*]`
- Review results saved to `$XDG_STATE_HOME/omnidev/ralph/<project>/prds/<status>/<prd>/review-results/`
- Review is best-effort — failures log warnings and proceed to testing

**Agent Interaction:**
- stdin/stdout piping to spawned agent processes
- Completion signal: `<promise>COMPLETE</promise>` in agent output
- Review signal: `<review-result>APPROVE|REQUEST_CHANGES</review-result>`
- Ctrl+C saves state to prd.json.lastRun before exit
- Agent prompts include: spec content (truncated to 3k chars), recent progress (20 lines), patterns

**State Management:**
- State stored at `$XDG_STATE_HOME/omnidev/ralph/<project>/` (defaults to `~/.local/state/...`)
- PRD folders: `prds/<status>/<name>/` with prd.json, spec.md, progress.txt
- Review results: `review-results/first-review.md`, `second-review.md`, `external-review.md`
- Swarm state: `swarm.json` in project state dir
- Story status: pending → in_progress → completed/blocked
- `project_name` required in config (slug format: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

## ANTI-PATTERNS

- **NEVER** skip reading progress.txt before starting iteration
- **NEVER** work on multiple stories in one iteration
- **NEVER** mark story as completed without running quality checks
- **NEVER** use `any` types or type assertions in agent code
- **NEVER** commit with failing tests or type errors
- **NEVER** create or switch git branches (work on current branch only)
- **NEVER** implement features outside story's acceptance criteria scope
- **NEVER** forget to update prd.json status after completing work
- **NEVER** replace progress.txt content — always append
- **NEVER** block story without adding questions to explain why
- **NEVER** start a PRD with unmet dependencies (CLI enforces this)
- **NEVER** introduce duplicate FR numbers, story IDs, or priority numbers after renumbering
- **NEVER** create PRDs from scratch when existing spec/plan files are available — use them as foundation
