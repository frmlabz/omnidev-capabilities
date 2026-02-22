/**
 * Session Backend
 *
 * Re-exports the SessionBackend interface and related types.
 * The interface is defined in types.ts alongside other swarm types.
 * Implementations live in separate files (e.g., session-tmux.ts).
 */

export type { SessionBackend, PaneInfo, PaneOptions } from "./types.js";
