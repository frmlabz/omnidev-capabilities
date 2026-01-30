/**
 * Worktree Scanner
 *
 * Detects git worktrees and associates them with PRDs.
 */

import { basename } from "node:path";

export interface Worktree {
	name: string; // Directory name
	path: string; // Full path
	branch: string; // Git branch
	isMain: boolean; // Is this the main worktree
	prdName: string | null; // Associated PRD (exact name match)
}

/**
 * Parse output of `git worktree list --porcelain`
 *
 * Format:
 * worktree /path/to/worktree
 * HEAD abc123...
 * branch refs/heads/branch-name
 * (blank line)
 */
export function parseWorktreeList(output: string): Omit<Worktree, "isMain" | "prdName">[] {
	const worktrees: Omit<Worktree, "isMain" | "prdName">[] = [];
	const blocks = output.trim().split("\n\n");

	for (const block of blocks) {
		const lines = block.trim().split("\n");
		let path = "";
		let branch = "";

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = line.substring(9);
			} else if (line.startsWith("branch ")) {
				// refs/heads/branch-name -> branch-name
				branch = line.substring(7).replace("refs/heads/", "");
			} else if (line === "detached") {
				branch = "(detached)";
			}
		}

		if (path) {
			worktrees.push({
				name: basename(path),
				path,
				branch: branch || "(unknown)",
			});
		}
	}

	return worktrees;
}

/**
 * Get all worktrees for a project
 *
 * Filters to only show:
 * - Main worktree
 * - Worktrees with a matching PRD (name === PRD name)
 *
 * Excludes:
 * - Root worktree (the folder where daemon runs)
 * - Worktrees without a matching PRD
 */
export async function getWorktrees(
	projectRoot: string,
	mainWorktreeName: string,
	prdNames: string[],
): Promise<Worktree[]> {
	const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
		cwd: projectRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git worktree list failed: ${stderr}`);
	}

	const rawWorktrees = parseWorktreeList(output);
	const prdNameSet = new Set(prdNames);

	// Get the root folder name (daemon runs here)
	const rootFolderName = basename(projectRoot);

	return rawWorktrees
		.map((wt) => ({
			...wt,
			isMain: wt.name === mainWorktreeName,
			// Exact name match for PRD association
			prdName: prdNameSet.has(wt.name) ? wt.name : null,
		}))
		.filter((wt) => {
			// Always include main worktree
			if (wt.isMain) return true;

			// Exclude root folder (where daemon runs, not a real worktree)
			if (wt.name === rootFolderName && wt.path === projectRoot) return false;

			// Only include worktrees that have a matching PRD
			return wt.prdName !== null;
		});
}

/**
 * Get the worktree for a specific PRD (exact name match)
 */
export function getWorktreeForPrd(worktrees: Worktree[], prdName: string): Worktree | null {
	return worktrees.find((wt) => wt.name === prdName) ?? null;
}

/**
 * Get the main worktree
 */
export function getMainWorktree(worktrees: Worktree[]): Worktree | null {
	return worktrees.find((wt) => wt.isMain) ?? null;
}
