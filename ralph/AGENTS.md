# RALPH CAPABILITY

**Generated:** 2026-01-12T10:36:46
**Commit:** (not specified)
**Branch:** (not specified)

## OVERVIEW
PRD-driven AI agent orchestrator for iterative feature development.

## STRUCTURE
```
capabilities/ralph/
├── index.ts              # Capability export (cliCommands, sync, gitignore)
├── orchestrator.ts       # PRD iteration loop, agent spawning, signal handling
├── state.ts             # PRD/story CRUD, progress tracking, archiving
├── sync.ts              # Directory setup, config.toml creation
├── cli.ts               # Stricli routes (list, status, start, progress)
├── prompt.ts            # Agent prompt generation from PRD context
├── types.d.ts           # TypeScript interfaces (PRD, Story, AgentConfig)
├── rules/               # Agent behavior guidelines
│   ├── iteration-workflow.md  # 13 rules for orchestration workflow
│   └── prd-structure.md      # PRD JSON structure rules
└── skills/              # Agent skill definitions
    └── prd-creation/
        └── SKILL.md     # PRD generation workflow
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Config loading | orchestrator.ts:32-117 | Manual TOML parser for config.toml |
| Agent spawning | orchestrator.ts:122-142 | Bun.spawn() with stdin/stdout pipes |
| Iteration logic | orchestrator.ts:171-317 | Ctrl+C handler, completion signal, blocked story check |
| PRD CRUD | state.ts:80-124 | getPRD, updatePRD, validation |
| Dependency checking | state.ts:256-330 | canStartPRD, getUnmetDependencies, buildDependencyGraph |
| Progress tracking | state.ts:199-224 | appendProgress, getProgress for learning patterns |
| CLI commands | cli.ts:208-320 | Stricli buildCommand for ralph routes |
| Prompt template | prompt.ts:37-185 | Generates context-aware agent prompts |

## CONVENTIONS

**Ralph-Specific:**
- Manual TOML parsing (orchestrator.ts) — no external library dependency
- Custom commit format: `feat: [<story-id>] - <title>`
- Progress.txt appends — never replaces existing content
- Codebase patterns extracted from progress.txt "## Codebase Patterns" section
- One story per iteration — enforced by getNextStory() priority sorting

**Agent Interaction:**
- stdin/stdout piping to spawned agent processes
- Completion signal: `<promise>COMPLETE</promise>` in agent output
- Ctrl+C saves state to prd.json.lastRun before exit
- Agent prompts include: spec content (truncated to 3k chars), recent progress (20 lines), patterns

**State Management:**
- PRD folders: `.omni/state/ralph/prds/<name>/` with prd.json, spec.md, progress.txt
- Archive: timestamp-prefixed folders moved to `completed-prds/`
- Story status: pending → in_progress → completed/blocked

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
