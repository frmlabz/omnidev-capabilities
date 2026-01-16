/**
 * Task Operations
 *
 * Core business logic for task management.
 * Used by both CLI and sandbox exports.
 */

import {
	deleteTask as deleteTaskFile,
	generateTaskId,
	loadAllTasks,
	loadTask,
	saveTask,
} from "./storage.js";
import type {
	Comment,
	CommentAuthor,
	CreateTaskInput,
	Task,
	TaskFilter,
	TaskStatus,
	UpdateTaskInput,
} from "./types.js";

/**
 * Generate a comment ID
 */
function generateCommentId(): string {
	return Math.random().toString(36).slice(2, 10);
}

/**
 * Create a new task
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
	const now = new Date().toISOString();

	const task: Task = {
		id: generateTaskId(),
		title: input.title,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		description: input.description || "",
		tags: input.tags || [],
		priority: input.priority !== undefined ? input.priority : 3,
		comments: [],
	};

	// Validate priority range
	if (task.priority < 1 || task.priority > 5) {
		throw new Error("Priority must be between 1 and 5");
	}

	await saveTask(task);
	return task;
}

/**
 * Get a single task by ID
 */
export async function getTask(taskId: string): Promise<Task> {
	return await loadTask(taskId);
}

/**
 * Get all tasks, optionally filtered
 */
export async function getTasks(filter?: TaskFilter): Promise<Task[]> {
	let tasks = await loadAllTasks();

	if (!filter) {
		return tasks;
	}

	// Filter by status
	if (filter.status) {
		const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
		tasks = tasks.filter((t) => statuses.includes(t.status));
	}

	// Filter by tags (task must have at least one matching tag)
	if (filter.tags && filter.tags.length > 0) {
		tasks = tasks.filter((t) => filter.tags?.some((tag) => t.tags.includes(tag)));
	}

	// Filter by priority
	if (filter.priority !== undefined) {
		tasks = tasks.filter((t) => t.priority === filter.priority);
	}

	if (filter.minPriority !== undefined) {
		const minPriority = filter.minPriority;
		tasks = tasks.filter((t) => t.priority >= minPriority);
	}

	if (filter.maxPriority !== undefined) {
		const maxPriority = filter.maxPriority;
		tasks = tasks.filter((t) => t.priority <= maxPriority);
	}

	return tasks;
}

/**
 * Update a task
 */
export async function updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task> {
	const task = await loadTask(taskId);

	// Apply updates
	if (updates.title !== undefined) task.title = updates.title;
	if (updates.status !== undefined) task.status = updates.status;
	if (updates.description !== undefined) task.description = updates.description;
	if (updates.tags !== undefined) task.tags = updates.tags;
	if (updates.priority !== undefined) {
		if (updates.priority < 1 || updates.priority > 5) {
			throw new Error("Priority must be between 1 and 5");
		}
		task.priority = updates.priority;
	}

	// Update timestamp
	task.updatedAt = new Date().toISOString();

	await saveTask(task);
	return task;
}

/**
 * Delete a task
 */
export async function deleteTask(taskId: string): Promise<void> {
	await deleteTaskFile(taskId);
}

/**
 * Add a comment to a task
 */
export async function addComment(
	taskId: string,
	content: string,
	author: CommentAuthor = "llm",
): Promise<Task> {
	const task = await loadTask(taskId);

	const comment: Comment = {
		id: generateCommentId(),
		author,
		content,
		timestamp: new Date().toISOString(),
	};

	task.comments.push(comment);
	task.updatedAt = new Date().toISOString();

	await saveTask(task);
	return task;
}

/**
 * Update task status (convenience function)
 */
export async function updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
	return await updateTask(taskId, { status });
}
