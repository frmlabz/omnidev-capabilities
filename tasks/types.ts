/**
 * Task Management Types
 *
 * Type definitions for the tasks capability.
 */

/**
 * Task status values
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

/**
 * Comment author type
 */
export type CommentAuthor = "user" | "llm";

/**
 * Comment on a task
 */
export interface Comment {
	/** Unique comment ID */
	id: string;

	/** Author of the comment (user or llm) */
	author: CommentAuthor;

	/** Comment content in markdown */
	content: string;

	/** ISO 8601 timestamp */
	timestamp: string;
}

/**
 * Task definition
 */
export interface Task {
	/** Unique task ID (timestamp-random format) */
	id: string;

	/** Task title */
	title: string;

	/** Current status */
	status: TaskStatus;

	/** Creation timestamp (ISO 8601) */
	createdAt: string;

	/** Last update timestamp (ISO 8601) */
	updatedAt: string;

	/** Task description/specification in markdown */
	description: string;

	/** Tags for categorization (e.g., bug, feature, enhancement) */
	tags: string[];

	/** Priority level (1-5, where 5 is highest) */
	priority: number;

	/** Comments on the task */
	comments: Comment[];
}

/**
 * Input for creating a new task
 */
export interface CreateTaskInput {
	/** Task title (required) */
	title: string;

	/** Task description in markdown (optional) */
	description?: string;

	/** Tags for categorization (optional) */
	tags?: string[];

	/** Priority level 1-5 (optional, defaults to 3) */
	priority?: number;
}

/**
 * Input for updating a task
 */
export interface UpdateTaskInput {
	/** New title (optional) */
	title?: string;

	/** New status (optional) */
	status?: TaskStatus;

	/** New description (optional) */
	description?: string;

	/** New tags (optional) */
	tags?: string[];

	/** New priority (optional) */
	priority?: number;
}

/**
 * Filter for querying tasks
 */
export interface TaskFilter {
	/** Filter by status (single or array) */
	status?: TaskStatus | TaskStatus[];

	/** Filter by tags (task must have at least one matching tag) */
	tags?: string[];

	/** Filter by exact priority */
	priority?: number;

	/** Filter by minimum priority */
	minPriority?: number;

	/** Filter by maximum priority */
	maxPriority?: number;
}
