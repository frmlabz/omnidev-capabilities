/**
 * Task CLI Commands
 *
 * CLI interface for task management using stricli.
 */

import { buildCommand, buildRouteMap } from "@stricli/core";
import {
	addComment,
	createTask,
	deleteTask as deleteTaskOp,
	getTask,
	getTasks,
	updateTask,
	updateTaskStatus,
} from "./operations.js";
import type { TaskStatus } from "./types.js";

/**
 * Create a new task
 */
async function runCreate(
	flags: {
		description?: string;
		tags?: string;
		priority?: number;
	},
	title: string,
): Promise<void> {
	const tags = flags.tags ? flags.tags.split(",").map((t) => t.trim()) : [];

	try {
		const input: {
			title: string;
			description?: string;
			tags?: string[];
			priority?: number;
		} = { title };
		if (flags.description) input.description = flags.description;
		if (tags.length > 0) input.tags = tags;
		if (flags.priority !== undefined) input.priority = flags.priority;

		const task = await createTask(input);

		console.log(`✓ Created task: ${task.id}`);
		console.log(`  Title: ${task.title}`);
		console.log(`  Priority: ${"⭐".repeat(task.priority)}`);
		if (tags.length > 0) {
			console.log(`  Tags: ${tags.join(", ")}`);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/**
 * List tasks
 */
async function runList(flags: {
	status?: TaskStatus;
	tags?: string;
	priority?: number;
}): Promise<void> {
	try {
		const filter: {
			status?: TaskStatus;
			tags?: string[];
			priority?: number;
		} = {};
		if (flags.status) filter.status = flags.status;
		if (flags.tags) filter.tags = flags.tags.split(",").map((t) => t.trim());
		if (flags.priority !== undefined) filter.priority = flags.priority;

		const tasks = await getTasks(Object.keys(filter).length > 0 ? filter : undefined);

		if (tasks.length === 0) {
			console.log("No tasks found.");
			return;
		}

		console.log(`\n=== Tasks (${tasks.length}) ===\n`);

		// Group by status
		const byStatus: Record<TaskStatus, typeof tasks> = {
			pending: [],
			in_progress: [],
			completed: [],
			blocked: [],
		};

		for (const task of tasks) {
			byStatus[task.status].push(task);
		}

		const printTask = (t: (typeof tasks)[0]) => {
			const priority = "⭐".repeat(t.priority);
			const tags = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
			console.log(`  ${t.id}: ${t.title} ${priority}${tags}`);
			if (t.comments.length > 0) {
				console.log(`    💬 ${t.comments.length} comment${t.comments.length > 1 ? "s" : ""}`);
			}
		};

		if (byStatus.in_progress.length > 0) {
			console.log("🔄 In Progress:");
			byStatus.in_progress.forEach(printTask);
			console.log();
		}

		if (byStatus.blocked.length > 0) {
			console.log("🚫 Blocked:");
			byStatus.blocked.forEach(printTask);
			console.log();
		}

		if (byStatus.pending.length > 0) {
			console.log("⏳ Pending:");
			byStatus.pending.forEach(printTask);
			console.log();
		}

		if (byStatus.completed.length > 0) {
			console.log("✅ Completed:");
			byStatus.completed.forEach(printTask);
			console.log();
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/**
 * Show task details
 */
async function runShow(_flags: Record<string, never>, taskId?: string): Promise<void> {
	if (!taskId) {
		console.error("Error: Task ID is required");
		console.error("\nUsage: omnidev task show <task-id>");
		process.exit(1);
	}

	try {
		const task = await getTask(taskId);

		console.log(`\n=== ${task.title} ===`);
		console.log(`ID: ${task.id}`);
		console.log(`Status: ${task.status}`);
		console.log(`Priority: ${"⭐".repeat(task.priority)}`);
		console.log(`Created: ${task.createdAt}`);
		console.log(`Updated: ${task.updatedAt}`);

		if (task.tags.length > 0) {
			console.log(`Tags: ${task.tags.join(", ")}`);
		}

		if (task.description) {
			console.log(`\n--- Description ---\n${task.description}`);
		}

		if (task.comments.length > 0) {
			console.log(`\n--- Comments (${task.comments.length}) ---`);
			for (const comment of task.comments) {
				console.log(`\n[${comment.author}] ${comment.timestamp}`);
				console.log(comment.content);
			}
		}
		console.log();
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/**
 * Update task status
 */
async function runStatus(
	_flags: Record<string, never>,
	taskId?: string,
	status?: string,
): Promise<void> {
	if (!taskId || !status) {
		console.error("Error: Task ID and status are required");
		console.error("\nUsage: omnidev task status <task-id> <status>");
		console.error("Status values: pending, in_progress, completed, blocked");
		process.exit(1);
	}

	const validStatuses: TaskStatus[] = ["pending", "in_progress", "completed", "blocked"];
	if (!validStatuses.includes(status as TaskStatus)) {
		console.error(`Error: Invalid status: ${status}`);
		console.error(`Valid values: ${validStatuses.join(", ")}`);
		process.exit(1);
	}

	try {
		const task = await updateTaskStatus(taskId, status as TaskStatus);
		console.log(`✓ Updated task ${task.id} to ${status}`);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/**
 * Update task fields
 */
async function runUpdate(
	flags: {
		title?: string;
		description?: string;
		tags?: string;
		priority?: number;
	},
	taskId?: string,
): Promise<void> {
	if (!taskId) {
		console.error("Error: Task ID is required");
		console.error(
			"\nUsage: omnidev task update <task-id> [--title ...] [--description ...] [--tags ...] [--priority N]",
		);
		process.exit(1);
	}

	const updates: {
		title?: string;
		description?: string;
		tags?: string[];
		priority?: number;
	} = {};
	if (flags.title) updates.title = flags.title;
	if (flags.description) updates.description = flags.description;
	if (flags.tags) updates.tags = flags.tags.split(",").map((t) => t.trim());
	if (flags.priority !== undefined) updates.priority = flags.priority;

	// Check if any updates were provided
	if (Object.keys(updates).length === 0) {
		console.error("Error: At least one field must be provided to update");
		console.error(
			"\nUsage: omnidev task update <task-id> [--title ...] [--description ...] [--tags ...] [--priority N]",
		);
		process.exit(1);
	}

	try {
		const task = await updateTask(taskId, updates);
		console.log(`✓ Updated task: ${task.id}`);
		console.log(`  Title: ${task.title}`);
		console.log(`  Priority: ${"⭐".repeat(task.priority)}`);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/**
 * Add comment to task
 */
async function runComment(
	flags: { author?: "user" | "llm"; message?: string },
	taskId?: string,
): Promise<void> {
	if (!taskId || !flags.message) {
		console.error("Error: Task ID and message are required");
		console.error(
			'\nUsage: omnidev task comment <task-id> --message "Your comment" [--author user|llm]',
		);
		process.exit(1);
	}

	const author = flags.author || "user";

	try {
		const task = await addComment(taskId, flags.message, author);
		console.log(`✓ Added comment to task ${task.id}`);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/**
 * Delete a task
 */
async function runDelete(_flags: Record<string, never>, taskId?: string): Promise<void> {
	if (!taskId) {
		console.error("Error: Task ID is required");
		console.error("\nUsage: omnidev task delete <task-id>");
		process.exit(1);
	}

	try {
		await deleteTaskOp(taskId);
		console.log(`✓ Deleted task: ${taskId}`);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

// Build commands
const createCommand = buildCommand({
	func: runCreate,
	parameters: {
		flags: {
			description: {
				kind: "parsed" as const,
				brief: "Task description (markdown)",
				parse: String,
				optional: true,
			},
			tags: {
				kind: "parsed" as const,
				brief: "Comma-separated tags (e.g., bug,urgent)",
				parse: String,
				optional: true,
			},
			priority: {
				kind: "parsed" as const,
				brief: "Priority (1-5, 5=highest)",
				parse: Number,
				optional: true,
			},
		},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "Task title",
					parse: String,
					optional: false,
				},
			],
		},
	},
	docs: {
		brief: "Create a new task",
	},
});

const listCommand = buildCommand({
	func: runList,
	parameters: {
		flags: {
			status: {
				kind: "enum" as const,
				brief: "Filter by status",
				values: ["pending", "in_progress", "completed", "blocked"] as const,
				optional: true,
			},
			tags: {
				kind: "parsed" as const,
				brief: "Filter by tags (comma-separated)",
				parse: String,
				optional: true,
			},
			priority: {
				kind: "parsed" as const,
				brief: "Filter by priority",
				parse: Number,
				optional: true,
			},
		},
	},
	docs: {
		brief: "List all tasks",
	},
});

const showCommand = buildCommand({
	func: runShow,
	parameters: {
		flags: {},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "Task ID",
					parse: String,
					optional: true,
				},
			],
		},
	},
	docs: {
		brief: "Show task details",
	},
});

const statusCommand = buildCommand({
	func: runStatus,
	parameters: {
		flags: {},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "Task ID",
					parse: String,
					optional: true,
				},
				{
					brief: "New status (pending|in_progress|completed|blocked)",
					parse: String,
					optional: true,
				},
			],
		},
	},
	docs: {
		brief: "Update task status",
	},
});

const updateCommand = buildCommand({
	func: runUpdate,
	parameters: {
		flags: {
			title: {
				kind: "parsed" as const,
				brief: "New title",
				parse: String,
				optional: true,
			},
			description: {
				kind: "parsed" as const,
				brief: "New description",
				parse: String,
				optional: true,
			},
			tags: {
				kind: "parsed" as const,
				brief: "New tags (comma-separated)",
				parse: String,
				optional: true,
			},
			priority: {
				kind: "parsed" as const,
				brief: "New priority (1-5)",
				parse: Number,
				optional: true,
			},
		},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "Task ID",
					parse: String,
					optional: true,
				},
			],
		},
	},
	docs: {
		brief: "Update task fields",
	},
});

const commentCommand = buildCommand({
	func: runComment,
	parameters: {
		flags: {
			message: {
				kind: "parsed" as const,
				brief: "Comment message",
				parse: String,
				optional: true,
			},
			author: {
				kind: "enum" as const,
				brief: "Comment author",
				values: ["user", "llm"] as const,
				optional: true,
			},
		},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "Task ID",
					parse: String,
					optional: true,
				},
			],
		},
	},
	docs: {
		brief: "Add comment to task",
	},
});

const deleteCommand = buildCommand({
	func: runDelete,
	parameters: {
		flags: {},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "Task ID",
					parse: String,
					optional: true,
				},
			],
		},
	},
	docs: {
		brief: "Delete a task",
	},
});

// Export route map
export const taskRoutes = buildRouteMap({
	routes: {
		create: createCommand,
		list: listCommand,
		show: showCommand,
		status: statusCommand,
		update: updateCommand,
		comment: commentCommand,
		delete: deleteCommand,
	},
	docs: {
		brief: "Task management",
	},
});
