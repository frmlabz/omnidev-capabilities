# Ralph Orchestrator - Implementation Plan

## Overview

Two-part system: **headless daemon** + **separate SSR web UI**. Both the daemon and CLI share a core library for PRD operations. The daemon exposes this functionality via HTTP/WebSocket, while the CLI provides terminal access.

## Core Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    UI Server (TanStack Start)                   │
│  • Discovers daemons via registry files                         │
│  • Connects to daemons via HTTP/WebSocket                       │
│  • Serves responsive React UI                                   │
│  • WebSocket to browser for real-time updates                   │
└─────────────────────────────────────────────────────────────────┘
            │                 │                 │
            ▼                 ▼                 ▼
     ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
     │  Daemon A   │   │  Daemon B   │   │  Daemon C   │
     │  Port 12345 │   │  Port 12789 │   │  Port 12456 │
     └─────────────┘   └─────────────┘   └─────────────┘
            │                 │                 │
            └────────────────┬┴─────────────────┘
                             ▼
                    ┌─────────────────┐
                    │  ralph/lib/     │  ← Shared core logic
                    │  (state, ops)   │
                    └─────────────────┘
                             ▲
                             │
                    ┌─────────────────┐
                    │  ralph CLI      │  ← Also uses lib
                    │  (terminal UI)  │
                    └─────────────────┘
```

## Refactored Ralph Structure

```
ralph/
├── lib/                          # Core logic (NEW - extracted)
│   ├── index.ts                  # Public API exports
│   ├── state.ts                  # PRD state management (moved from state.ts)
│   ├── orchestrator.ts           # Orchestration logic (moved)
│   ├── testing.ts                # Testing logic (moved)
│   └── types.ts                  # Shared types
├── cli.ts                        # CLI (uses lib/)
├── index.ts                      # Capability entry point
└── ...
```

**Key principle**: `ralph/lib/` is a pure library with no CLI dependencies. It exports functions that return data structures, not formatted strings.

---

## Component 1: Daemon

### Behavior
1. On start: pick random available port (10000-60000 range)
2. Register in `~/.local/state/ralph-orchestrator/daemons/<id>.json`
3. Import `ralph/lib/` directly for PRD operations
4. Expose HTTP API + WebSocket
5. Heartbeat every 30s (update timestamp in registry)
6. On shutdown: remove registration file

### Source of Truth
- **Local filesystem** via `ralph/lib/` functions
- Daemon doesn't duplicate state, just exposes lib functions via API

### Registration File
Location: `~/.local/state/ralph-orchestrator/daemons/<daemon-id>.json`

```json
{
  "schemaVersion": 1,
  "id": "a1b2c3d4",
  "projectPath": "/home/user/projects/omnidev",
  "projectName": "omnidev-capabilities",
  "host": "127.0.0.1",
  "port": 12345,
  "pid": 12345,
  "startedAt": "2025-01-30T10:00:00Z",
  "lastHeartbeat": "2025-01-30T10:05:00Z"
}
```

### API Design

**Standard Response Envelope:**
```typescript
interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}
```

**Endpoints:**
```
GET  /api/health              # { ok: true } - always responds if alive
GET  /api/info                # Daemon info (project name, path, version)
GET  /api/prds                # List all PRDs with status
GET  /api/prds/:name          # PRD details (status, stories, progress)
POST /api/prds/:name/start    # Start developing PRD (spawns process)
POST /api/prds/:name/stop     # Stop PRD development
POST /api/prds/:name/test     # Run tests
GET  /api/prds/:name/logs     # Get logs (query: ?tail=100)
WS   /ws                      # WebSocket for real-time updates
```

### WebSocket Protocol

**Events (Daemon → Client):**
```typescript
{ type: 'prd:status', prd: string, status: PRDStatus, timestamp: string }
{ type: 'prd:log', prd: string, line: string, timestamp: string }
{ type: 'prd:progress', prd: string, story: string, iteration: number }
{ type: 'daemon:heartbeat', timestamp: string }
{ type: 'connected', daemonId: string, projectName: string }
```

**Commands (Client → Daemon):**
```typescript
{ type: 'subscribe', prds: string[] }
{ type: 'unsubscribe', prds: string[] }
```

**Reconnection:** Exponential backoff (1s, 2s, 4s... max 30s). On reconnect, client re-subscribes.

### Process Management
- Long-running operations (start, test) spawn child processes
- Track by PID, can be stopped via `/api/prds/:name/stop`
- Logs buffered in ring buffer (last 1000 lines per PRD)

### File Structure
```
ralph-orchestrator/
├── packages/
│   └── daemon/
│       ├── src/
│       │   ├── index.ts          # Entry point
│       │   ├── server.ts         # HTTP + WebSocket server
│       │   ├── registry.ts       # Register/unregister/heartbeat
│       │   ├── process-manager.ts # Spawn/track child processes
│       │   ├── log-buffer.ts     # Ring buffer for logs
│       │   └── types.ts
│       ├── package.json
│       └── tsconfig.json
```

---

## Component 2: UI (TanStack Start)

### Behavior
1. Server starts on configured port (default 3000)
2. Reads `~/.local/state/ralph-orchestrator/daemons/` on startup
3. Validates each daemon (check PID alive, call /api/health)
4. Prunes stale entries (heartbeat > 2min old, or health check fails)
5. Connects WebSocket to each valid daemon
6. Serves React UI, proxies WebSocket to browser

### Technology Stack
- **Framework**: TanStack Start (full-stack React with SSR)
- **Styling**: Tailwind CSS (mobile-first)
- **Runtime**: Bun
- **State**: TanStack Query + WebSocket for real-time
- **Validation**: Zod schemas for API responses

### File Structure
```
ralph-orchestrator/
├── packages/
│   └── ui/
│       ├── app/
│       │   ├── routes/
│       │   │   ├── __root.tsx         # Root layout
│       │   │   ├── index.tsx          # Dashboard
│       │   │   └── prd.$daemon.$name.tsx  # PRD detail
│       │   ├── components/
│       │   │   ├── DaemonCard.tsx
│       │   │   ├── PRDCard.tsx
│       │   │   ├── PRDDetail.tsx
│       │   │   ├── LogViewer.tsx
│       │   │   └── StatusBadge.tsx
│       │   ├── lib/
│       │   │   ├── daemon-discovery.ts   # Read registry, validate
│       │   │   ├── daemon-client.ts      # HTTP + WS client
│       │   │   └── schemas.ts            # Zod schemas
│       │   └── styles.css
│       ├── app.config.ts
│       ├── package.json
│       └── tailwind.config.js
```

### UI Views

**Dashboard**
```
┌────────────────────────────────────────────┐
│  Ralph Orchestrator              [Refresh] │
├────────────────────────────────────────────┤
│                                            │
│  Connected Daemons (2)                     │
│  ┌──────────────────────────────────────┐  │
│  │ 🟢 omnidev-capabilities              │  │
│  │    /home/user/projects/omnidev       │  │
│  │    3 PRDs • 1 developing             │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │ 🔴 my-app (offline)                  │  │
│  │    Last seen: 2 min ago              │  │
│  └──────────────────────────────────────┘  │
│                                            │
├────────────────────────────────────────────┤
│  All PRDs                                  │
│  ┌──────────────────────────────────────┐  │
│  │ auth-system           [DEVELOPING]   │  │
│  │ omnidev • Story 3/5 • Iteration 2    │  │
│  │ [Stop] [Logs]                        │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

**PRD Detail (responsive)**
```
┌────────────────────────────────────────────┐
│  ← auth-system                             │
├────────────────────────────────────────────┤
│  Status: DEVELOPING                        │
│  Project: omnidev-capabilities             │
│  Stories: 3/5 completed                    │
│  Current: Implement login endpoint         │
│  Iteration: 2                              │
│                                            │
│  ████████████░░░░░░░░ 60%                  │
│                                            │
├────────────────────────────────────────────┤
│  [Stop]  [Test]  [View Files]              │
├────────────────────────────────────────────┤
│  Live Logs (auto-scroll)                   │
│  ──────────────────────────────────────    │
│  10:42:15 Starting story: login endpoint   │
│  10:42:16 Reading spec file...             │
│  10:42:18 Agent working on implementation  │
│  10:42:25 Writing src/auth/login.ts        │
└────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 0: Extract ralph/lib/
- Move core logic from `state.ts`, `orchestrator.ts`, `testing.ts` into `ralph/lib/`
- Keep CLI working, just import from `lib/` instead
- No functional changes, just reorganization

### Phase 1: Daemon MVP
- Project setup (ralph-orchestrator/packages/daemon)
- Registry (register, heartbeat, cleanup)
- HTTP server with `/api/health`, `/api/info`, `/api/prds`
- Basic WebSocket (heartbeat only)

### Phase 2: UI MVP
- TanStack Start setup
- Daemon discovery + validation
- Dashboard showing daemons and PRDs
- Basic Tailwind styling (responsive)

### Phase 3: Real-time & Controls
- WebSocket events for PRD status changes
- Log streaming (ring buffer in daemon, WS to UI)
- Start/Stop controls
- Live log viewer

### Phase 4: Polish
- Error handling + loading states
- Reconnection logic
- Mobile optimization
- Dark mode (optional)

---

## Operational Considerations

### Daemon Lifecycle
- **Stale detection**: UI checks `lastHeartbeat` < 2min, calls `/api/health`
- **Cleanup**: UI prunes dead entries on startup
- **Graceful shutdown**: Daemon removes own registry file via SIGINT/SIGTERM handler

### Port Selection
- Random port in 10000-60000 range
- Retry up to 10 times if port busy
- Save chosen port in registry

### Logs
- Ring buffer: 1000 lines per PRD
- Truncate old lines on overflow
- Stream new lines via WebSocket

### Binding
- Default: `127.0.0.1` (localhost only)
- Flag: `--bind 0.0.0.0` for Tailscale access
- Store bind address in registry for UI

---

## Commands

```bash
# Start daemon in current project
cd /path/to/project
ralph-daemon
ralph-daemon --bind 0.0.0.0  # For Tailscale

# Start UI
ralph-ui
ralph-ui --port 8080

# List daemons (utility)
ralph-daemon list
```

---

## Testing Strategy

### Contract Tests
- Daemon API responses match Zod schemas
- WebSocket events match expected format

### Failure Modes
- Stale registry file (daemon died)
- Port conflict on startup
- WebSocket disconnect/reconnect
- Daemon unreachable (network)

### Integration
- Spawn daemon, call APIs, verify responses
- Connect WebSocket, trigger events, verify received

---

## Future Phases (After MVP)

### Phase 5: Worktree Management
- Create git worktrees for PRD branches
- Switch between worktrees
- Show worktree status in UI

### Phase 6: Auto Development Loop
- Start PRD → develop → test → fix cycle
- Auto-restart on test failure
- Progress tracking through iterations

### Phase 7: Merge Integration
- Auto-merge completed PRDs to main
- Conflict detection and notification

---

## Schema Definitions (Zod)

```typescript
// Shared schemas for daemon API responses
const PRDStatusSchema = z.enum(['pending', 'testing', 'completed']);

const StorySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
  priority: z.number(),
});

const PRDSummarySchema = z.object({
  name: z.string(),
  status: PRDStatusSchema,
  description: z.string(),
  progress: z.object({ completed: z.number(), total: z.number() }),
  canStart: z.boolean(),
  hasBlockedStories: z.boolean(),
});

const PRDDetailSchema = PRDSummarySchema.extend({
  stories: z.array(StorySchema),
  dependencies: z.array(z.string()),
  startedAt: z.string().optional(),
  metrics: z.object({
    iterations: z.number(),
    totalTokens: z.number(),
  }).optional(),
});

const ApiResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    ok: z.boolean(),
    data: dataSchema.optional(),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }).optional(),
  });
```
