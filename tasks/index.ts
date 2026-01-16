/**
 * Tasks Capability
 *
 * Task management capability for OmniDev.
 * Provides CLI commands and sandbox-accessible functions for managing tasks.
 */

import type { CapabilityExport, SandboxToolExport } from "@omnidev-ai/core";
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

// JSON Schema definitions for sandbox tools
const taskStatusSchema = {
	type: "string",
	enum: ["pending", "in_progress", "completed", "blocked"],
	description: "Task status",
};

const taskOutputSchema = {
	type: "object",
	properties: {
		id: { type: "string", description: "Unique task ID" },
		title: { type: "string", description: "Task title" },
		status: taskStatusSchema,
		createdAt: { type: "string", description: "ISO 8601 creation timestamp" },
		updatedAt: { type: "string", description: "ISO 8601 update timestamp" },
		description: { type: "string", description: "Task description in markdown" },
		tags: {
			type: "array",
			items: { type: "string" },
			description: "Tags for categorization",
		},
		priority: {
			type: "number",
			minimum: 1,
			maximum: 5,
			description: "Priority level (1-5, where 5 is highest)",
		},
		comments: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					author: { type: "string", enum: ["user", "llm"] },
					content: { type: "string" },
					timestamp: { type: "string" },
				},
			},
		},
	},
};

// Sandbox tool definitions with full schemas
const sandboxTools: Record<string, SandboxToolExport> = {
	createTask: {
		name: "createTask",
		description: "Create a new task with title, description, tags, and priority",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Task title (required)",
				},
				description: {
					type: "string",
					description: "Task description in markdown",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Tags for categorization (e.g., bug, feature)",
				},
				priority: {
					type: "number",
					minimum: 1,
					maximum: 5,
					default: 3,
					description: "Priority level 1-5 (default: 3)",
				},
			},
			required: ["title"],
		},
		outputSchema: taskOutputSchema,
		specification: `/**
 * Create a new task in the task management system.
 *
 * @param input.title - The title of the task (required)
 * @param input.description - Optional markdown description
 * @param input.tags - Optional array of tags for categorization
 * @param input.priority - Priority level 1-5 (default: 3, where 5 is highest)
 * @returns The created Task object with generated ID and timestamps
 *
 * @example
 * const task = await createTask({
 *   title: "Fix login bug",
 *   description: "Users can't login with special characters",
 *   tags: ["bug", "auth"],
 *   priority: 5
 * });
 * console.log(task.id); // "1704067200000-abc123"
 */`,
	},

	getTasks: {
		name: "getTasks",
		description: "Get all tasks with optional filtering by status, tags, or priority",
		inputSchema: {
			type: "object",
			properties: {
				status: {
					oneOf: [taskStatusSchema, { type: "array", items: taskStatusSchema }],
					description: "Filter by status (single or array)",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Filter by tags (task must have at least one matching tag)",
				},
				priority: {
					type: "number",
					description: "Filter by exact priority",
				},
				minPriority: {
					type: "number",
					description: "Filter by minimum priority",
				},
				maxPriority: {
					type: "number",
					description: "Filter by maximum priority",
				},
			},
		},
		outputSchema: {
			type: "array",
			items: taskOutputSchema,
			description: "Array of matching tasks",
		},
		specification: `/**
 * Get all tasks with optional filtering.
 *
 * @param filter.status - Filter by status (single or array)
 * @param filter.tags - Filter by tags (task must have at least one matching tag)
 * @param filter.priority - Filter by exact priority
 * @param filter.minPriority - Filter by minimum priority
 * @param filter.maxPriority - Filter by maximum priority
 * @returns Array of tasks matching the filter criteria
 *
 * @example
 * // Get all pending tasks
 * const pending = await getTasks({ status: "pending" });
 *
 * // Get high priority bugs
 * const urgentBugs = await getTasks({
 *   tags: ["bug"],
 *   minPriority: 4
 * });
 */`,
	},

	getTask: {
		name: "getTask",
		description: "Get a single task by ID",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Task ID to retrieve",
				},
			},
			required: ["id"],
		},
		outputSchema: {
			oneOf: [taskOutputSchema, { type: "null" }],
			description: "Task object or null if not found",
		},
		specification: `/**
 * Get a single task by its ID.
 *
 * @param input.id - The task ID to retrieve
 * @returns The Task object or null if not found
 *
 * @example
 * const task = await getTask({ id: "1704067200000-abc123" });
 * if (task) {
 *   console.log(task.title);
 * }
 */`,
	},

	updateTask: {
		name: "updateTask",
		description: "Update a task's fields (title, description, tags, priority, status)",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Task ID to update",
				},
				title: {
					type: "string",
					description: "New title",
				},
				status: taskStatusSchema,
				description: {
					type: "string",
					description: "New description",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "New tags (replaces existing)",
				},
				priority: {
					type: "number",
					minimum: 1,
					maximum: 5,
					description: "New priority",
				},
			},
			required: ["id"],
		},
		outputSchema: {
			oneOf: [taskOutputSchema, { type: "null" }],
			description: "Updated task or null if not found",
		},
		specification: `/**
 * Update a task's fields.
 *
 * @param input.id - Task ID to update (required)
 * @param input.title - New title (optional)
 * @param input.status - New status (optional)
 * @param input.description - New description (optional)
 * @param input.tags - New tags, replaces existing (optional)
 * @param input.priority - New priority 1-5 (optional)
 * @returns Updated Task object or null if not found
 *
 * @example
 * const updated = await updateTask({
 *   id: "1704067200000-abc123",
 *   status: "in_progress",
 *   priority: 5
 * });
 */`,
	},

	deleteTask: {
		name: "deleteTask",
		description: "Delete a task by ID",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Task ID to delete",
				},
			},
			required: ["id"],
		},
		outputSchema: {
			type: "boolean",
			description: "True if deleted, false if not found",
		},
		specification: `/**
 * Delete a task by its ID.
 *
 * @param input.id - Task ID to delete
 * @returns true if deleted, false if task not found
 *
 * @example
 * const deleted = await deleteTask({ id: "1704067200000-abc123" });
 * if (deleted) {
 *   console.log("Task deleted");
 * }
 */`,
	},

	addComment: {
		name: "addComment",
		description: "Add a comment to a task (by user or llm)",
		inputSchema: {
			type: "object",
			properties: {
				taskId: {
					type: "string",
					description: "Task ID to comment on",
				},
				content: {
					type: "string",
					description: "Comment content in markdown",
				},
				author: {
					type: "string",
					enum: ["user", "llm"],
					default: "llm",
					description: "Comment author (default: llm)",
				},
			},
			required: ["taskId", "content"],
		},
		outputSchema: {
			oneOf: [taskOutputSchema, { type: "null" }],
			description: "Updated task with new comment, or null if task not found",
		},
		specification: `/**
 * Add a comment to a task.
 *
 * @param input.taskId - Task ID to comment on (required)
 * @param input.content - Comment content in markdown (required)
 * @param input.author - Comment author: "user" or "llm" (default: "llm")
 * @returns Updated Task object or null if task not found
 *
 * @example
 * const task = await addComment({
 *   taskId: "1704067200000-abc123",
 *   content: "Started working on this",
 *   author: "llm"
 * });
 */`,
	},

	updateTaskStatus: {
		name: "updateTaskStatus",
		description: "Update a task's status (pending, in_progress, completed, blocked)",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Task ID to update",
				},
				status: {
					...taskStatusSchema,
					description: "New status value",
				},
			},
			required: ["id", "status"],
		},
		outputSchema: {
			oneOf: [taskOutputSchema, { type: "null" }],
			description: "Updated task or null if not found",
		},
		specification: `/**
 * Update a task's status.
 *
 * Shorthand for updateTask({ id, status }).
 *
 * @param input.id - Task ID to update (required)
 * @param input.status - New status: "pending", "in_progress", "completed", or "blocked"
 * @returns Updated Task object or null if task not found
 *
 * @example
 * const task = await updateTaskStatus({
 *   id: "1704067200000-abc123",
 *   status: "completed"
 * });
 */`,
	},
};

// Default export: CapabilityExport
export default {
	cliCommands: {
		task: taskRoutes,
	},

	sandboxTools: sandboxTools,

	gitignore: ["tasks/"],

	sync,
} satisfies CapabilityExport;
