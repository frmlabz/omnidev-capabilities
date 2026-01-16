# PROJECT KNOWLEDGE BASE - TASKS CAPABILITY

## OVERVIEW
Task management capability with sandbox tools for CRUD operations and CLI commands.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Capability export | index.ts | Sandbox tools (7 functions) with full JSON schemas |
| Task operations | operations.ts | CRUD: createTask, getTask, getTasks, updateTask, deleteTask, addComment, updateTaskStatus |
| Task persistence | storage.ts | File I/O: saveTask, loadTask, loadAllTasks in .omni/state/tasks/ |
| CLI commands | cli.ts | Stricli routes: create, list, show, status, update, comment, delete |
| Type definitions | types.ts | Task, TaskStatus, Comment, CreateTaskInput, UpdateTaskInput, TaskFilter |
| Sync hook | sync.ts | Creates .omni/state/tasks/ directory during sync |

## CONVENTIONS

**Task Storage:**
- Each task stored as separate JSON: `.omni/state/tasks/{task-id}.json`
- Task ID format: `{timestamp}-{random}` (e.g., "1704067200000-abc123")
- Never create task IDs manually - always use generated ones

**Priority:**
- Integer 1-5 (5 = highest priority, 3 = default)
- Validated in both createTask and updateTask operations
- Throws Error if outside range

**Status:**
- Enum values: "pending", "in_progress", "completed", "blocked"
- updateTaskStatus() shorthand for status-only updates

**Comments:**
- Author field: "user" or "llm" (default: "llm")
- Stored in task.comments array with ISO timestamps

**Sandbox Tool Schemas:**
- All sandbox functions export complete JSON schemas (input + output)
- Specification strings include JSDoc examples
- Used by omnidev to generate type-safe tool definitions

## ANTI-PATTERNS

- **NEVER** create custom task IDs - use generateTaskId() from storage.ts
- **NEVER** modify .omni/state/tasks/*.json files directly - use CRUD operations
- **NEVER** use priority values outside 1-5 range - validation throws Error
- **NEVER** store non-JSON data in task files - must be valid JSON structure
- **NEVER** mix array and single status values - getTasks handles both, but operations expect specific types
