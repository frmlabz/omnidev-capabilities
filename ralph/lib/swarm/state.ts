/**
 * Swarm State Persistence
 *
 * Manages swarm.json — the ephemeral session metadata file that tracks
 * which PRDs are running in which worktrees/panes.
 *
 * This file is NOT committed to git (it's session-specific).
 * It lives at $XDG_STATE_HOME/omnidev/ralph/<project>/swarm.json.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type Result, ok, err } from "../results.js";
import type {
	SwarmState,
	RunInstance,
	RunStatus,
	PersistedRunInstance,
	SessionBackend,
} from "./types.js";
import { getSwarmStatePath, atomicWrite } from "../core/paths.js";

/**
 * Load swarm state from disk
 */
export async function loadSwarmState(
	projectName: string,
	repoRoot: string,
): Promise<Result<SwarmState>> {
	const statePath = getSwarmStatePath(projectName, repoRoot);

	if (!existsSync(statePath)) {
		return ok({ session: "", runs: {} });
	}

	try {
		const content = await readFile(statePath, "utf-8");
		const state = JSON.parse(content) as SwarmState;
		return ok(state);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return err("STATE_READ_FAILED", `Failed to read swarm state: ${msg}`);
	}
}

/**
 * Save swarm state to disk (atomic write via rename)
 */
export async function saveSwarmState(
	projectName: string,
	repoRoot: string,
	state: SwarmState,
): Promise<Result<void>> {
	try {
		await atomicWrite(getSwarmStatePath(projectName, repoRoot), JSON.stringify(state, null, 2));
		return ok(undefined);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return err("STATE_WRITE_FAILED", `Failed to save swarm state: ${msg}`);
	}
}

/**
 * Add or update a run instance in state
 */
export async function upsertRun(
	projectName: string,
	repoRoot: string,
	sessionName: string,
	instance: RunInstance,
): Promise<Result<void>> {
	const stateResult = await loadSwarmState(projectName, repoRoot);
	if (!stateResult.ok) return err(stateResult.error!.code, stateResult.error!.message);

	const state = stateResult.data!;
	state.session = sessionName;
	state.runs[instance.prdName] = {
		worktree: instance.worktree,
		branch: instance.branch,
		paneId: instance.paneId,
		startedAt: instance.startedAt,
		status: instance.status,
		windowId: instance.windowId,
	};

	return saveSwarmState(projectName, repoRoot, state);
}

/**
 * Update the status of a run instance
 */
export async function updateRunStatus(
	projectName: string,
	repoRoot: string,
	prdName: string,
	status: RunStatus,
): Promise<Result<void>> {
	const stateResult = await loadSwarmState(projectName, repoRoot);
	if (!stateResult.ok) return err(stateResult.error!.code, stateResult.error!.message);

	const state = stateResult.data!;
	const run = state.runs[prdName];
	if (!run) return err("NOT_RUNNING", `No run found for PRD: ${prdName}`);

	run.status = status;
	return saveSwarmState(projectName, repoRoot, state);
}

/**
 * Remove a run instance from state
 */
export async function removeRun(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<Result<void>> {
	const stateResult = await loadSwarmState(projectName, repoRoot);
	if (!stateResult.ok) return err(stateResult.error!.code, stateResult.error!.message);

	const state = stateResult.data!;
	delete state.runs[prdName];
	return saveSwarmState(projectName, repoRoot, state);
}

/**
 * Get a single run instance from state
 */
export async function getRun(
	projectName: string,
	repoRoot: string,
	prdName: string,
): Promise<Result<RunInstance | null>> {
	const stateResult = await loadSwarmState(projectName, repoRoot);
	if (!stateResult.ok) return err(stateResult.error!.code, stateResult.error!.message);

	const state = stateResult.data!;
	const persisted = state.runs[prdName];
	if (!persisted) return ok(null);

	return ok(toRunInstance(prdName, persisted));
}

/**
 * Get all run instances from state
 */
export async function getAllRuns(
	projectName: string,
	repoRoot: string,
): Promise<Result<RunInstance[]>> {
	const stateResult = await loadSwarmState(projectName, repoRoot);
	if (!stateResult.ok) return err(stateResult.error!.code, stateResult.error!.message);

	const state = stateResult.data!;
	const instances = Object.entries(state.runs).map(([name, persisted]) =>
		toRunInstance(name, persisted),
	);

	return ok(instances);
}

/**
 * Reconcile persisted state with live session backend state.
 *
 * Marks instances as "stale" if their pane is dead. Returns reconciled list.
 */
export async function reconcile(
	projectName: string,
	repoRoot: string,
	session: SessionBackend,
): Promise<Result<RunInstance[]>> {
	const stateResult = await loadSwarmState(projectName, repoRoot);
	if (!stateResult.ok) return err(stateResult.error!.code, stateResult.error!.message);

	const state = stateResult.data!;
	const instances: RunInstance[] = [];
	let dirty = false;

	for (const [name, persisted] of Object.entries(state.runs)) {
		const instance = toRunInstance(name, persisted);

		// Check if the pane is still alive
		if (persisted.status === "running") {
			const aliveResult = await session.isPaneAlive(persisted.paneId);
			if (aliveResult.ok && !aliveResult.data) {
				instance.status = "stale";
				persisted.status = "stale";
				dirty = true;
			}
		}

		instances.push(instance);
	}

	// Persist changes if any instances were marked stale
	if (dirty) {
		await saveSwarmState(projectName, repoRoot, state);
	}

	return ok(instances);
}

/**
 * Convert persisted run data to a full RunInstance
 */
function toRunInstance(prdName: string, persisted: PersistedRunInstance): RunInstance {
	return {
		prdName,
		worktree: persisted.worktree,
		branch: persisted.branch,
		paneId: persisted.paneId,
		startedAt: persisted.startedAt,
		status: persisted.status,
		windowId: persisted.windowId,
	};
}
