/**
 * Task CLI Commands
 *
 * CLI interface for task management.
 */

import { command, routes } from "@omnidev-ai/capability";
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
async function runCreate(flags: Record<string, unknown>, title?: unknown): Promise<void> {
	if (!title || typeof title !== "string") {
		console.error("Error: Task title is required");
		console.error(
			"\nUsage: omnidev task create <title> [--description ...] [--tags ...] [--priority N]",
		);
		process.exit(1);
	}

	const tagsStr = typeof flags["tags"] === "string" ? flags["tags"] : undefined;
	const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : [];
	const description = typeof flags["description"] === "string" ? flags["description"] : undefined;
	const priority = typeof flags["priority"] === "number" ? flags["priority"] : undefined;

	try {
		const input: {
			title: string;
			description?: string;
			tags?: string[];
			priority?: number;
		} = { title };
		if (description) input.description = description;
		if (tags.length > 0) input.tags = tags;
		if (priority !== undefined) input.priority = priority;

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
async function runList(flags: Record<string, unknown>): Promise<void> {
	try {
		const status =
			typeof flags["status"] === "string" ? (flags["status"] as TaskStatus) : undefined;
		const tagsStr = typeof flags["tags"] === "string" ? flags["tags"] : undefined;
		const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : undefined;
		const priority = typeof flags["priority"] === "number" ? flags["priority"] : undefined;

		const filter: {
			status?: TaskStatus;
			tags?: string[];
			priority?: number;
		} = {};
		if (status) filter.status = status;
		if (tags) filter.tags = tags;
		if (priority !== undefined) filter.priority = priority;

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
			const priorityStars = "⭐".repeat(t.priority);
			const tagsDisplay = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
			console.log(`  ${t.id}: ${t.title} ${priorityStars}${tagsDisplay}`);
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
async function runShow(_flags: Record<string, unknown>, taskId?: unknown): Promise<void> {
	if (!taskId || typeof taskId !== "string") {
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
	_flags: Record<string, unknown>,
	taskId?: unknown,
	status?: unknown,
): Promise<void> {
	if (!taskId || typeof taskId !== "string" || !status || typeof status !== "string") {
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
async function runUpdate(flags: Record<string, unknown>, taskId?: unknown): Promise<void> {
	if (!taskId || typeof taskId !== "string") {
		console.error("Error: Task ID is required");
		console.error(
			"\nUsage: omnidev task update <task-id> [--title ...] [--description ...] [--tags ...] [--priority N]",
		);
		process.exit(1);
	}

	const title = typeof flags["title"] === "string" ? flags["title"] : undefined;
	const description = typeof flags["description"] === "string" ? flags["description"] : undefined;
	const tagsStr = typeof flags["tags"] === "string" ? flags["tags"] : undefined;
	const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : undefined;
	const priority = typeof flags["priority"] === "number" ? flags["priority"] : undefined;

	const updates: {
		title?: string;
		description?: string;
		tags?: string[];
		priority?: number;
	} = {};
	if (title) updates.title = title;
	if (description) updates.description = description;
	if (tags) updates.tags = tags;
	if (priority !== undefined) updates.priority = priority;

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
async function runComment(flags: Record<string, unknown>, taskId?: unknown): Promise<void> {
	const message = typeof flags["message"] === "string" ? flags["message"] : undefined;

	if (!taskId || typeof taskId !== "string" || !message) {
		console.error("Error: Task ID and message are required");
		console.error(
			'\nUsage: omnidev task comment <task-id> --message "Your comment" [--author user|llm]',
		);
		process.exit(1);
	}

	const author = flags["author"] === "user" || flags["author"] === "llm" ? flags["author"] : "user";

	try {
		const task = await addComment(taskId, message, author);
		console.log(`✓ Added comment to task ${task.id}`);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

/**
 * Delete a task
 */
async function runDelete(_flags: Record<string, unknown>, taskId?: unknown): Promise<void> {
	if (!taskId || typeof taskId !== "string") {
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
const createCommand = command({
	brief: "Create a new task",
	parameters: {
		flags: {
			description: {
				kind: "string",
				brief: "Task description (markdown)",
				optional: true,
			},
			tags: {
				kind: "string",
				brief: "Comma-separated tags (e.g., bug,urgent)",
				optional: true,
			},
			priority: {
				kind: "number",
				brief: "Priority (1-5, 5=highest)",
				optional: true,
			},
		},
		positional: [{ brief: "Task title", kind: "string" }],
	},
	func: runCreate,
});

const listCommand = command({
	brief: "List all tasks",
	parameters: {
		flags: {
			status: {
				kind: "enum",
				brief: "Filter by status",
				values: ["pending", "in_progress", "completed", "blocked"],
				optional: true,
			},
			tags: {
				kind: "string",
				brief: "Filter by tags (comma-separated)",
				optional: true,
			},
			priority: {
				kind: "number",
				brief: "Filter by priority",
				optional: true,
			},
		},
	},
	func: runList,
});

const showCommand = command({
	brief: "Show task details",
	parameters: {
		positional: [{ brief: "Task ID", kind: "string", optional: true }],
	},
	func: runShow,
});

const statusCommand = command({
	brief: "Update task status",
	parameters: {
		positional: [
			{ brief: "Task ID", kind: "string", optional: true },
			{
				brief: "New status (pending|in_progress|completed|blocked)",
				kind: "string",
				optional: true,
			},
		],
	},
	func: runStatus,
});

const updateCommand = command({
	brief: "Update task fields",
	parameters: {
		flags: {
			title: {
				kind: "string",
				brief: "New title",
				optional: true,
			},
			description: {
				kind: "string",
				brief: "New description",
				optional: true,
			},
			tags: {
				kind: "string",
				brief: "New tags (comma-separated)",
				optional: true,
			},
			priority: {
				kind: "number",
				brief: "New priority (1-5)",
				optional: true,
			},
		},
		positional: [{ brief: "Task ID", kind: "string", optional: true }],
	},
	func: runUpdate,
});

const commentCommand = command({
	brief: "Add comment to task",
	parameters: {
		flags: {
			message: {
				kind: "string",
				brief: "Comment message",
				optional: true,
			},
			author: {
				kind: "enum",
				brief: "Comment author",
				values: ["user", "llm"],
				optional: true,
			},
		},
		positional: [{ brief: "Task ID", kind: "string", optional: true }],
	},
	func: runComment,
});

const deleteCommand = command({
	brief: "Delete a task",
	parameters: {
		positional: [{ brief: "Task ID", kind: "string", optional: true }],
	},
	func: runDelete,
});

// Export route map
export const taskRoutes = routes({
	brief: "Task management",
	routes: {
		create: createCommand,
		list: listCommand,
		show: showCommand,
		status: statusCommand,
		update: updateCommand,
		comment: commentCommand,
		delete: deleteCommand,
	},
});
