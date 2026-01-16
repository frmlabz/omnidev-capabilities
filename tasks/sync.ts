/**
 * Task Sync Hook
 *
 * Initializes the tasks directory during omnidev sync.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const TASKS_DIR = ".omni/state/tasks";

/**
 * Sync hook called by omnidev sync.
 * Creates tasks directory.
 */
export async function sync(): Promise<void> {
	console.log("Tasks: Setting up directory structure...");

	const tasksPath = join(process.cwd(), TASKS_DIR);
	mkdirSync(tasksPath, { recursive: true });

	console.log("Tasks: Sync complete");
}
