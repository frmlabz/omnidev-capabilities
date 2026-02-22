/**
 * SwarmManager — the main API for parallel PRD execution
 *
 * Consumer-agnostic. CLI, web UI, or any other consumer instantiates this
 * with a config and a session backend, then calls structured methods.
 * All methods return Result<T> — no console output, no assumptions about
 * the session backend implementation.
 */

import { existsSync } from "node:fs";
import { type Result, ok, err } from "../results.js";
import type {
	SwarmConfig,
	RunInstance,
	StartOptions,
	TestOptions,
	MergeResult,
	ConflictReport,
	RecoverResult,
	SessionBackend,
} from "./types.js";
import {
	createWorktree,
	removeWorktree,
	mergeWorktree,
	checkMergeConflicts,
	isMainWorktree,
	resolveWorktreePath,
	listWorktrees,
	hasUncommittedChanges,
	interpolateWorktreeCmd,
} from "./worktree.js";
import {
	loadSwarmState,
	upsertRun,
	updateRunStatus,
	removeRun,
	getRun,
	reconcile,
} from "./state.js";
import { findPRDLocation, hasPRDFile, canStartPRD, getPRD } from "../state.js";
import type { PRD } from "../types.js";

export class SwarmManager {
	private config: SwarmConfig;
	private session: SessionBackend;
	private sessionName: string;
	private cwd: string;
	private projectName: string;
	private repoRoot: string;

	constructor(
		config: SwarmConfig,
		session: SessionBackend,
		sessionName: string,
		projectName: string,
		repoRoot: string,
		cwd?: string,
	) {
		this.config = config;
		this.session = session;
		this.sessionName = sessionName;
		this.projectName = projectName;
		this.repoRoot = repoRoot;
		this.cwd = cwd ?? process.cwd();
	}

	/**
	 * Start a PRD in a new worktree + session pane
	 */
	async start(prdName: string, options?: StartOptions): Promise<Result<RunInstance>> {
		// Pre-flight checks
		const checks = await this.preflight(prdName);
		if (!checks.ok) return err(checks.error!.code, checks.error!.message);

		// Check not already running
		const existing = await getRun(this.projectName, this.repoRoot, prdName);
		if (existing.ok && existing.data && existing.data.status === "running") {
			return err("ALREADY_RUNNING", `PRD "${prdName}" is already running`, {
				paneId: existing.data.paneId,
				worktree: existing.data.worktree,
			});
		}

		// Check dependencies
		const { canStart, unmetDependencies } = await canStartPRD(
			this.projectName,
			this.repoRoot,
			prdName,
		);
		if (!canStart) {
			return err(
				"DEPS_UNMET",
				`PRD "${prdName}" has unmet dependencies: ${unmetDependencies.join(", ")}`,
				{
					dependencies: unmetDependencies,
				},
			);
		}

		// Check session backend availability
		const available = await this.session.isAvailable();
		if (!available) {
			return err(
				"SESSION_BACKEND_UNAVAILABLE",
				`Session backend "${this.session.name}" is not available. Is ${this.session.name} installed?`,
			);
		}

		// Create worktree (or defer to custom command)
		const branch = prdName;
		const worktreePath = resolveWorktreePath(prdName, this.config.worktree_parent, this.cwd);
		let panePrefix: string;

		if (this.config.worktree_create_cmd) {
			// Custom command runs inside the pane — handles worktree creation + cd
			panePrefix = interpolateWorktreeCmd(this.config.worktree_create_cmd, {
				name: prdName,
				path: worktreePath,
				branch,
			});
		} else {
			// Default: programmatic git worktree add, then cd
			const wtResult = await createWorktree(prdName, this.config.worktree_parent, this.cwd);
			if (!wtResult.ok) return err(wtResult.error!.code, wtResult.error!.message);
			panePrefix = `cd "${wtResult.data!.path}"`;
		}

		// Ensure session exists
		const sessionResult = await this.session.ensureSession(this.sessionName);
		if (!sessionResult.ok) return err(sessionResult.error!.code, sessionResult.error!.message);

		// Build the orchestration command
		const agentFlag = options?.agent ? ` --agent ${options.agent}` : "";
		const timeout = this.config.pane_close_timeout;
		const command = `${panePrefix} && omnidev ralph start ${prdName}${agentFlag}; echo "[finished]"; read -t ${timeout} || true`;

		// Create pane
		const paneResult = await this.session.createPane(this.sessionName, {
			title: prdName,
			command,
		});
		if (!paneResult.ok) return err(paneResult.error!.code, paneResult.error!.message);

		const pane = paneResult.data!;

		// Build run instance
		const instance: RunInstance = {
			prdName,
			worktree: worktreePath,
			branch: prdName,
			paneId: pane.paneId,
			startedAt: new Date().toISOString(),
			status: "running",
			windowId: pane.windowId,
		};

		// Persist to state
		const saveResult = await upsertRun(this.projectName, this.repoRoot, this.sessionName, instance);
		if (!saveResult.ok) return err(saveResult.error!.code, saveResult.error!.message);

		return ok(instance);
	}

	/**
	 * Stop a running PRD (sends interrupt)
	 */
	async stop(prdName: string): Promise<Result<void>> {
		const runResult = await getRun(this.projectName, this.repoRoot, prdName);
		if (!runResult.ok) return err(runResult.error!.code, runResult.error!.message);
		if (!runResult.data) return err("NOT_RUNNING", `PRD "${prdName}" is not running`);

		const run = runResult.data;

		// Send interrupt to pane
		const intResult = await this.session.sendInterrupt(run.paneId);
		if (!intResult.ok) return err(intResult.error!.code, intResult.error!.message);

		// Update status
		return updateRunStatus(this.projectName, this.repoRoot, prdName, "stopped");
	}

	/**
	 * Stop all running PRDs
	 */
	async stopAll(): Promise<Result<void>> {
		const runsResult = await reconcile(this.projectName, this.repoRoot, this.session);
		if (!runsResult.ok) return err(runsResult.error!.code, runsResult.error!.message);

		const running = runsResult.data!.filter((r) => r.status === "running");
		for (const run of running) {
			await this.stop(run.prdName);
		}

		return ok(undefined);
	}

	/**
	 * Start testing for a PRD in its worktree
	 */
	async test(prdName: string, options?: TestOptions): Promise<Result<RunInstance>> {
		const runResult = await getRun(this.projectName, this.repoRoot, prdName);
		if (!runResult.ok) return err(runResult.error!.code, runResult.error!.message);

		// PRD must have an existing worktree (either running or stopped)
		if (!runResult.data) {
			return err("NOT_RUNNING", `PRD "${prdName}" has no worktree. Start it first.`);
		}

		const run = runResult.data;

		// If still running, stop it first
		if (run.status === "running") {
			await this.stop(prdName);
		}

		// Ensure session exists
		const sessionResult = await this.session.ensureSession(this.sessionName);
		if (!sessionResult.ok) return err(sessionResult.error!.code, sessionResult.error!.message);

		// Build test command
		const agentFlag = options?.agent ? ` --agent ${options.agent}` : "";
		const timeout = this.config.pane_close_timeout;
		const command = `cd "${run.worktree}" && omnidev ralph test ${prdName}${agentFlag}; echo "[finished]"; read -t ${timeout} || true`;

		// Create pane for testing
		const paneResult = await this.session.createPane(this.sessionName, {
			title: `test:${prdName}`,
			command,
		});
		if (!paneResult.ok) return err(paneResult.error!.code, paneResult.error!.message);

		const pane = paneResult.data!;

		// Update instance
		const instance: RunInstance = {
			...run,
			paneId: pane.paneId,
			status: "running",
			windowId: pane.windowId,
		};

		await upsertRun(this.projectName, this.repoRoot, this.sessionName, instance);
		return ok(instance);
	}

	/**
	 * Merge a PRD's worktree branch back into main
	 */
	async merge(prdName: string): Promise<Result<MergeResult>> {
		const runResult = await getRun(this.projectName, this.repoRoot, prdName);
		const worktreePath =
			runResult.ok && runResult.data
				? runResult.data.worktree
				: resolveWorktreePath(prdName, this.config.worktree_parent, this.cwd);
		const branch = prdName;

		// Verify worktree exists
		if (!existsSync(worktreePath)) {
			return err("WORKTREE_NOT_FOUND", `No worktree found for PRD "${prdName}" at ${worktreePath}`);
		}

		// Check for uncommitted changes in worktree
		const dirtyResult = await hasUncommittedChanges(worktreePath);
		if (dirtyResult.ok && dirtyResult.data) {
			return err(
				"WORKTREE_DIRTY",
				`Worktree for "${prdName}" has uncommitted changes. Commit or stash first.`,
			);
		}

		// Merge
		const mergeResult = await mergeWorktree(branch, this.cwd);
		if (!mergeResult.ok) {
			return err(mergeResult.error!.code, mergeResult.error!.message, mergeResult.error!.details);
		}

		const { commitSha, filesChanged } = mergeResult.data!;

		// Clean up: remove worktree + branch
		await removeWorktree(worktreePath, branch, this.cwd);

		// Destroy pane if it exists
		if (runResult.ok && runResult.data) {
			await this.session.destroyPane(runResult.data.paneId).catch(() => {});
			await removeRun(this.projectName, this.repoRoot, prdName);
		}

		// Rebalance remaining panes
		await this.session.rebalance(this.sessionName).catch(() => {});

		return ok({
			prdName,
			commitSha,
			filesChanged,
			hadConflicts: false,
		});
	}

	/**
	 * Merge all completed/stopped PRDs
	 */
	async mergeAll(): Promise<Result<MergeResult[]>> {
		const runsResult = await reconcile(this.projectName, this.repoRoot, this.session);
		if (!runsResult.ok) return err(runsResult.error!.code, runsResult.error!.message);

		const mergeable = runsResult.data!.filter(
			(r) => r.status === "completed" || r.status === "stopped" || r.status === "stale",
		);

		const results: MergeResult[] = [];
		for (const run of mergeable) {
			const mergeResult = await this.merge(run.prdName);
			if (mergeResult.ok && mergeResult.data) {
				results.push(mergeResult.data);
			}
		}

		return ok(results);
	}

	/**
	 * Clean up a PRD's worktree and session resources (without merging)
	 */
	async cleanup(prdName: string): Promise<Result<void>> {
		const runResult = await getRun(this.projectName, this.repoRoot, prdName);
		const worktreePath =
			runResult.ok && runResult.data
				? runResult.data.worktree
				: resolveWorktreePath(prdName, this.config.worktree_parent, this.cwd);
		const branch = prdName;

		// Destroy pane if it exists
		if (runResult.ok && runResult.data) {
			await this.session.destroyPane(runResult.data.paneId).catch(() => {});
		}

		// Remove worktree + branch
		if (existsSync(worktreePath)) {
			const removeResult = await removeWorktree(worktreePath, branch, this.cwd);
			if (!removeResult.ok) return removeResult;
		}

		// Remove from state
		await removeRun(this.projectName, this.repoRoot, prdName);

		// Rebalance
		await this.session.rebalance(this.sessionName).catch(() => {});

		return ok(undefined);
	}

	/**
	 * Clean up all stale/stopped runs
	 */
	async cleanupAll(): Promise<Result<void>> {
		const runsResult = await reconcile(this.projectName, this.repoRoot, this.session);
		if (!runsResult.ok) return err(runsResult.error!.code, runsResult.error!.message);

		const cleanable = runsResult.data!.filter(
			(r) => r.status === "stale" || r.status === "stopped" || r.status === "completed",
		);

		for (const run of cleanable) {
			await this.cleanup(run.prdName);
		}

		return ok(undefined);
	}

	/**
	 * Recover from session loss (tmux died, machine restarted, etc.)
	 *
	 * Cross-references state with live session and disk to find orphans.
	 */
	async recover(): Promise<Result<RecoverResult>> {
		const stateResult = await loadSwarmState(this.projectName, this.repoRoot);
		if (!stateResult.ok) return err(stateResult.error!.code, stateResult.error!.message);

		const state = stateResult.data!;
		const result: RecoverResult = { recovered: [], orphaned: [], cleaned: [] };

		for (const [name, persisted] of Object.entries(state.runs)) {
			const worktreeExists = existsSync(persisted.worktree);
			const paneAlive = await this.session.isPaneAlive(persisted.paneId);
			const isPaneAlive = paneAlive.ok && paneAlive.data;

			if (worktreeExists && isPaneAlive) {
				// Still running — just update status
				result.recovered.push({
					prdName: name,
					worktree: persisted.worktree,
					branch: persisted.branch,
					paneId: persisted.paneId,
					startedAt: persisted.startedAt,
					status: "running",
					windowId: persisted.windowId,
				});
			} else if (worktreeExists && !isPaneAlive) {
				// Orphaned: worktree exists but no pane
				result.orphaned.push({
					prdName: name,
					worktree: persisted.worktree,
					branch: persisted.branch,
				});
				// Update state to stale
				persisted.status = "stale";
			} else {
				// Nothing on disk — clean up state
				result.cleaned.push(name);
				delete state.runs[name];
			}
		}

		// Also check for worktrees on disk that aren't in state
		const wtResult = await listWorktrees(this.cwd);
		if (wtResult.ok && wtResult.data) {
			for (const wt of wtResult.data) {
				if (wt.isBare) continue;
				const branch = wt.branch;
				if (!branch || branch === "(detached)") continue;

				// Check if this worktree has a PRD that's not in state
				const inState = branch in state.runs;
				if (!inState) {
					const prdLocation = findPRDLocation(this.projectName, this.repoRoot, branch);
					if (prdLocation) {
						result.orphaned.push({
							prdName: branch,
							worktree: wt.path,
							branch,
						});
					}
				}
			}
		}

		// Save updated state
		const { saveSwarmState: saveState } = await import("./state.js");
		await saveState(this.projectName, this.repoRoot, state);

		return ok(result);
	}

	/**
	 * List all run instances with live status reconciliation
	 */
	async list(): Promise<Result<RunInstance[]>> {
		return reconcile(this.projectName, this.repoRoot, this.session);
	}

	/**
	 * Get a single run instance
	 */
	async get(prdName: string): Promise<Result<RunInstance>> {
		const runResult = await getRun(this.projectName, this.repoRoot, prdName);
		if (!runResult.ok) return err(runResult.error!.code, runResult.error!.message);
		if (!runResult.data) return err("NOT_RUNNING", `No run found for PRD: ${prdName}`);
		return ok(runResult.data);
	}

	/**
	 * Check for merge conflicts across all running PRDs
	 */
	async conflicts(): Promise<Result<ConflictReport[]>> {
		const runsResult = await reconcile(this.projectName, this.repoRoot, this.session);
		if (!runsResult.ok) return err(runsResult.error!.code, runsResult.error!.message);

		const reports: ConflictReport[] = [];

		for (const run of runsResult.data!) {
			const conflictResult = await checkMergeConflicts(run.branch, this.cwd);
			if (conflictResult.ok && conflictResult.data && conflictResult.data.hasConflicts) {
				reports.push({
					prdName: run.prdName,
					branch: run.branch,
					conflictFiles: conflictResult.data.conflictFiles,
					summary: `${conflictResult.data.conflictFiles.length} file(s) would conflict when merging "${run.branch}" into current branch`,
				});
			}
		}

		return ok(reports);
	}

	/**
	 * Attach to a PRD's pane (interactive — delegates to session backend)
	 */
	async attach(prdName: string): Promise<Result<void>> {
		const runResult = await getRun(this.projectName, this.repoRoot, prdName);
		if (!runResult.ok) return err(runResult.error!.code, runResult.error!.message);
		if (!runResult.data) return err("NOT_RUNNING", `No run found for PRD: ${prdName}`);

		return this.session.focusPane(runResult.data.paneId);
	}

	/**
	 * Get recent log output from a PRD's pane
	 */
	async logs(prdName: string, tail = 100): Promise<Result<string>> {
		const runResult = await getRun(this.projectName, this.repoRoot, prdName);
		if (!runResult.ok) return err(runResult.error!.code, runResult.error!.message);
		if (!runResult.data) return err("NOT_RUNNING", `No run found for PRD: ${prdName}`);

		// Capture pane output via tmux
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			const { stdout } = await execFileAsync("tmux", [
				"capture-pane",
				"-t",
				runResult.data.paneId,
				"-p",
				"-S",
				`-${tail}`,
			]);
			return ok(stdout);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("CAPTURE_FAILED", msg);
		}
	}

	/**
	 * Pre-flight checks common to start operations
	 */
	private async preflight(prdName: string): Promise<Result<void>> {
		// Must be run from main worktree
		const mainResult = await isMainWorktree(this.cwd);
		if (mainResult.ok && !mainResult.data) {
			return err("NOT_MAIN_WORKTREE", "Swarm commands must be executed from the main worktree");
		}

		// PRD must exist
		const prdLocation = findPRDLocation(this.projectName, this.repoRoot, prdName);
		if (!prdLocation) {
			return err("PRD_NOT_FOUND", `PRD "${prdName}" not found`);
		}

		// PRD must have prd.json (not spec-only)
		if (!hasPRDFile(this.projectName, this.repoRoot, prdName)) {
			return err(
				"PRD_INVALID_STATUS",
				`PRD "${prdName}" only has a spec — stories must be defined before running`,
			);
		}

		return ok(undefined);
	}
}

/**
 * Convenience: read prd.json from central XDG state (not worktree-local)
 */
export async function readWorktreePRD(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<Result<PRD>> {
	try {
		const prd = await getPRD(projectName, repoRoot, prdName);
		return ok(prd);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return err("PRD_NOT_FOUND", msg);
	}
}
