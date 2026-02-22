/**
 * Ralph Path Resolution
 *
 * Single source of truth for state directory paths.
 * All state lives at $XDG_STATE_HOME/omnidev/ralph/<project_name>/
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { PRDStatus } from "../types.js";

const PROJECT_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate a project name against the slug format.
 * Must be lowercase alphanumeric + hyphens, no leading/trailing hyphens, 1-64 chars.
 */
export function validateProjectName(name: string): boolean {
	return name.length >= 1 && name.length <= 64 && PROJECT_NAME_RE.test(name);
}

/**
 * Derive the project key used as the state directory name.
 * This is just the project name — each project must have a unique name.
 */
export function getProjectKey(projectName: string, _repoRoot: string): string {
	return projectName;
}

/**
 * Get the XDG state home directory.
 * Defaults to ~/.local/state per the XDG Base Directory Specification.
 */
export function getXdgStateHome(): string {
	return process.env["XDG_STATE_HOME"] || join(process.env["HOME"] || "~", ".local", "state");
}

/**
 * Get the root state directory for a project.
 * e.g. ~/.local/state/omnidev/ralph/myapp/
 */
export function getStateDir(projectName: string, repoRoot: string): string {
	return join(getXdgStateHome(), "omnidev", "ralph", getProjectKey(projectName, repoRoot));
}

/**
 * Get the prds/ directory.
 */
export function getPrdsDir(projectName: string, repoRoot: string): string {
	return join(getStateDir(projectName, repoRoot), "prds");
}

/**
 * Get a status-specific directory (e.g. prds/pending/).
 */
export function getStatusDir(projectName: string, repoRoot: string, status: PRDStatus): string {
	return join(getPrdsDir(projectName, repoRoot), status);
}

/**
 * Get the path to swarm.json.
 */
export function getSwarmStatePath(projectName: string, repoRoot: string): string {
	return join(getStateDir(projectName, repoRoot), "swarm.json");
}

/**
 * Ensure all status directories exist under the state dir.
 */
export function ensureStateDirs(projectName: string, repoRoot: string): void {
	const statuses: PRDStatus[] = ["pending", "in_progress", "testing", "completed"];
	for (const status of statuses) {
		mkdirSync(getStatusDir(projectName, repoRoot, status), {
			recursive: true,
		});
	}
}

/**
 * Atomic write: write to a tmp file then rename.
 * Prevents partial reads if the process is interrupted during a write.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.tmp`;
	mkdirSync(dirname(filePath), { recursive: true });
	await writeFile(tmpPath, content);
	await rename(tmpPath, filePath);
}
