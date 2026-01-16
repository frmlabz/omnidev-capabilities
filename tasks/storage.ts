/**
 * Task Storage
 *
 * File I/O operations for individual task files.
 * Each task is stored as .omni/state/tasks/{task-id}.json
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types.js";

const TASKS_DIR = ".omni/state/tasks";

/**
 * Generate a unique task ID
 * Format: {timestamp}-{random}
 */
export function generateTaskId(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).slice(2, 7);
	return `${timestamp}-${random}`;
}

/**
 * Get the path to a task file
 */
function getTaskPath(taskId: string): string {
	return join(process.cwd(), TASKS_DIR, `${taskId}.json`);
}

/**
 * Ensure tasks directory exists
 */
export function ensureTasksDir(): void {
	const tasksPath = join(process.cwd(), TASKS_DIR);
	if (!existsSync(tasksPath)) {
		mkdirSync(tasksPath, { recursive: true });
	}
}

/**
 * Save a task to disk
 */
export async function saveTask(task: Task): Promise<void> {
	ensureTasksDir();
	const path = getTaskPath(task.id);
	await Bun.write(path, JSON.stringify(task, null, 2));
}

/**
 * Load a task from disk
 */
export async function loadTask(taskId: string): Promise<Task> {
	const path = getTaskPath(taskId);

	if (!existsSync(path)) {
		throw new Error(`Task not found: ${taskId}`);
	}

	try {
		const content = await Bun.file(path).text();
		const task = JSON.parse(content) as Task;

		// Validate task structure
		if (!task.id || !task.title || !task.status) {
			throw new Error(`Invalid task structure: ${taskId}`);
		}

		return task;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in task file: ${taskId}`);
		}
		throw error;
	}
}

/**
 * List all task IDs
 */
export async function listTaskIds(): Promise<string[]> {
	const tasksPath = join(process.cwd(), TASKS_DIR);

	if (!existsSync(tasksPath)) {
		return [];
	}

	const files = readdirSync(tasksPath);
	return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
}

/**
 * Load all tasks
 */
export async function loadAllTasks(): Promise<Task[]> {
	const taskIds = await listTaskIds();
	const tasks: Task[] = [];

	for (const taskId of taskIds) {
		try {
			const task = await loadTask(taskId);
			tasks.push(task);
		} catch (error) {
			console.error(`Failed to load task ${taskId}:`, error);
		}
	}

	return tasks;
}

/**
 * Delete a task file
 */
export async function deleteTask(taskId: string): Promise<void> {
	const path = getTaskPath(taskId);

	if (!existsSync(path)) {
		throw new Error(`Task not found: ${taskId}`);
	}

	const { unlinkSync } = await import("node:fs");
	unlinkSync(path);
}

/**
 * Check if a task exists
 */
export function taskExists(taskId: string): boolean {
	const path = getTaskPath(taskId);
	return existsSync(path);
}
