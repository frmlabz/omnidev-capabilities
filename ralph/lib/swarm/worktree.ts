/**
 * Git Worktree Operations
 *
 * Creates, removes, lists, and merges git worktrees for parallel PRD development.
 * Supports the sibling worktree layout where worktrees are siblings of the main checkout.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Result, ok, err } from "../results.js";

const execFileAsync = promisify(execFile);

/**
 * Execute a git command from a given working directory
 */
async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("git", args, { cwd, timeout: 30_000 });
}

/**
 * Execute git and return a Result
 */
async function gitResult(args: string[], cwd: string): Promise<Result<string>> {
	try {
		const { stdout } = await git(args, cwd);
		return ok(stdout.trim());
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return err("GIT_ERROR", msg);
	}
}

/**
 * Information about an existing worktree
 */
export interface WorktreeInfo {
	path: string;
	branch: string;
	head: string;
	isBare: boolean;
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(cwd: string): Promise<Result<string>> {
	return gitResult(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/**
 * Check if a branch exists
 */
export async function branchExists(branch: string, cwd: string): Promise<Result<boolean>> {
	try {
		await git(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
		return ok(true);
	} catch {
		return ok(false);
	}
}

/**
 * List all worktrees
 */
export async function listWorktrees(cwd: string): Promise<Result<WorktreeInfo[]>> {
	const result = await gitResult(["worktree", "list", "--porcelain"], cwd);
	if (!result.ok) return err(result.error!.code, result.error!.message);

	const worktrees: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};

	for (const line of result.data!.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) worktrees.push(current as WorktreeInfo);
			current = { path: line.slice(9), isBare: false };
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice(5);
		} else if (line.startsWith("branch refs/heads/")) {
			current.branch = line.slice(18);
		} else if (line === "bare") {
			current.isBare = true;
		} else if (line === "detached") {
			current.branch = "(detached)";
		} else if (line === "" && current.path) {
			worktrees.push(current as WorktreeInfo);
			current = {};
		}
	}
	if (current.path) worktrees.push(current as WorktreeInfo);

	return ok(worktrees);
}

/**
 * Resolve the worktree path for a PRD name
 */
export function resolveWorktreePath(prdName: string, worktreeParent: string, cwd: string): string {
	return resolve(cwd, worktreeParent, prdName);
}

/**
 * Variables available for worktree command template interpolation
 */
export interface WorktreeCmdVars {
	/** PRD name */
	name: string;
	/** Resolved worktree path */
	path: string;
	/** Branch name */
	branch: string;
}

/**
 * Interpolate a worktree command template with the given variables.
 *
 * Replaces `{name}`, `{path}`, and `{branch}` placeholders.
 */
export function interpolateWorktreeCmd(template: string, vars: WorktreeCmdVars): string {
	return template
		.replace(/\{name\}/g, vars.name)
		.replace(/\{path\}/g, vars.path)
		.replace(/\{branch\}/g, vars.branch);
}

/**
 * Create a worktree for a PRD
 *
 * Creates a new branch with the PRD name and a worktree at the resolved path.
 * If the worktree already exists with the correct branch, reuses it.
 */
export async function createWorktree(
	prdName: string,
	worktreeParent: string,
	cwd: string,
): Promise<Result<{ path: string; branch: string; reused: boolean }>> {
	const worktreePath = resolveWorktreePath(prdName, worktreeParent, cwd);
	const branch = prdName;

	// Check if worktree already exists on disk
	if (existsSync(worktreePath)) {
		// Verify it's actually a worktree with the right branch
		const branchResult = await getCurrentBranch(worktreePath);
		if (branchResult.ok && branchResult.data === branch) {
			return ok({ path: worktreePath, branch, reused: true });
		}
		return err(
			"WORKTREE_EXISTS",
			`Path ${worktreePath} exists but is not a worktree for branch "${branch}" (found branch: ${branchResult.ok ? branchResult.data : "unknown"})`,
		);
	}

	// Check if branch already exists
	const branchExistsResult = await branchExists(branch, cwd);
	if (!branchExistsResult.ok)
		return err(branchExistsResult.error!.code, branchExistsResult.error!.message);

	try {
		if (branchExistsResult.data) {
			// Branch exists — create worktree with existing branch
			await git(["worktree", "add", worktreePath, branch], cwd);
		} else {
			// Create new branch + worktree
			await git(["worktree", "add", "-b", branch, worktreePath], cwd);
		}

		return ok({ path: worktreePath, branch, reused: false });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return err("WORKTREE_CREATE_FAILED", `Failed to create worktree: ${msg}`);
	}
}

/**
 * Remove a worktree and optionally delete its branch
 */
export async function removeWorktree(
	worktreePath: string,
	branch: string,
	cwd: string,
	deleteBranch = true,
): Promise<Result<void>> {
	try {
		// Remove the worktree (--force handles uncommitted changes)
		await git(["worktree", "remove", worktreePath, "--force"], cwd);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		// If worktree is already gone, that's fine
		if (!msg.includes("is not a working tree")) {
			return err("WORKTREE_REMOVE_FAILED", msg);
		}
	}

	// Prune stale worktree entries
	await git(["worktree", "prune"], cwd).catch(() => {});

	if (deleteBranch) {
		try {
			await git(["branch", "-D", branch], cwd);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (!msg.includes("not found")) {
				return err("BRANCH_DELETE_FAILED", msg);
			}
		}
	}

	return ok(undefined);
}

/**
 * Check if a worktree has uncommitted changes
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<Result<boolean>> {
	const result = await gitResult(["status", "--porcelain"], worktreePath);
	if (!result.ok) return err(result.error!.code, result.error!.message);
	return ok(result.data!.length > 0);
}

/**
 * Merge a worktree branch into the current branch (main)
 *
 * Must be called from the main worktree. Returns conflict info if merge fails.
 */
export async function mergeWorktree(
	branch: string,
	cwd: string,
): Promise<Result<{ commitSha: string; filesChanged: string[] }>> {
	// Check for uncommitted changes in main
	const dirtyResult = await hasUncommittedChanges(cwd);
	if (!dirtyResult.ok) return err(dirtyResult.error!.code, dirtyResult.error!.message);
	if (dirtyResult.data) {
		return err("MAIN_DIRTY", "Main worktree has uncommitted changes. Commit or stash first.");
	}

	try {
		// Merge with --no-ff to always create a merge commit
		await git(["merge", branch, "--no-ff", "-m", `merge: ${branch}`], cwd);

		// Get the merge commit SHA
		const shaResult = await gitResult(["rev-parse", "HEAD"], cwd);
		if (!shaResult.ok) return err(shaResult.error!.code, shaResult.error!.message);

		// Get files changed
		const diffResult = await gitResult(["diff", "--name-only", "HEAD~1", "HEAD"], cwd);
		const filesChanged =
			diffResult.ok && diffResult.data ? diffResult.data.split("\n").filter(Boolean) : [];

		return ok({ commitSha: shaResult.data!, filesChanged });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);

		if (msg.includes("CONFLICT") || msg.includes("Automatic merge failed")) {
			// Get conflicted files
			const conflictResult = await gitResult(["diff", "--name-only", "--diff-filter=U"], cwd);
			const conflictFiles =
				conflictResult.ok && conflictResult.data
					? conflictResult.data.split("\n").filter(Boolean)
					: [];

			// Abort the merge
			await git(["merge", "--abort"], cwd).catch(() => {});

			return err("MERGE_CONFLICT", `Merge conflicts in: ${conflictFiles.join(", ")}`, {
				conflictFiles,
			});
		}

		return err("MERGE_FAILED", msg);
	}
}

/**
 * Check for potential merge conflicts without actually merging (dry run)
 */
export async function checkMergeConflicts(
	branch: string,
	cwd: string,
): Promise<Result<{ hasConflicts: boolean; conflictFiles: string[] }>> {
	try {
		// Use merge-tree for a non-destructive conflict check
		const baseResult = await gitResult(["merge-base", "HEAD", branch], cwd);
		if (!baseResult.ok) return err(baseResult.error!.code, baseResult.error!.message);

		const treeResult = await gitResult(["merge-tree", baseResult.data!, "HEAD", branch], cwd);

		if (!treeResult.ok) {
			return ok({ hasConflicts: false, conflictFiles: [] });
		}

		// merge-tree outputs conflict markers if there are conflicts
		const hasConflicts = treeResult.data!.includes("changed in both");
		const conflictFiles: string[] = [];

		if (hasConflicts) {
			for (const match of treeResult.data!.matchAll(
				/changed in both\n\s+base\s+\d+ \w+ \w+\s+(\S+)/g,
			)) {
				if (match[1]) conflictFiles.push(match[1]);
			}
		}

		return ok({ hasConflicts, conflictFiles });
	} catch {
		// If merge-tree fails, assume no conflicts (conservative)
		return ok({ hasConflicts: false, conflictFiles: [] });
	}
}

/**
 * Get the main worktree path (the one that's not a linked worktree)
 */
export async function getMainWorktreePath(cwd: string): Promise<Result<string>> {
	const result = await listWorktrees(cwd);
	if (!result.ok) return err(result.error!.code, result.error!.message);

	// The first worktree in the list is always the main one
	const main = result.data![0];
	if (!main) return err("NO_WORKTREES", "No worktrees found");

	return ok(main.path);
}

/**
 * Check if the current directory is the main worktree (not a linked worktree)
 */
export async function isMainWorktree(cwd: string): Promise<Result<boolean>> {
	const mainResult = await getMainWorktreePath(cwd);
	if (!mainResult.ok) return err(mainResult.error!.code, mainResult.error!.message);

	const resolvedCwd = resolve(cwd);
	const resolvedMain = resolve(mainResult.data!);
	return ok(resolvedCwd === resolvedMain);
}
