/**
 * Tasks Capability
 *
 * Task management capability for OmniDev.
 * Provides CLI commands and sandbox-accessible functions for managing tasks.
 */

import type { CapabilityExport } from "@omnidev-ai/capability";
import { taskRoutes } from "./cli.js";
import { sync } from "./sync.js";

// Export sandbox functions (accessible via omni_execute)
export {
	addComment,
	createTask,
	deleteTask,
	getTask,
	getTasks,
	updateTask,
	updateTaskStatus,
} from "./operations.js";
// Export types for TypeScript consumers
export type {
	Comment,
	CommentAuthor,
	CreateTaskInput,
	Task,
	TaskFilter,
	TaskStatus,
	UpdateTaskInput,
} from "./types.js";

// Default export: CapabilityExport
export default {
	cliCommands: {
		task: taskRoutes,
	},

	gitignore: ["tasks/"],

	sync,
} satisfies CapabilityExport;
