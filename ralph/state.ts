/**
 * Ralph State Management
 *
 * Functions for persisting and retrieving PRDs, stories, and progress.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LastRun, PRD, Story, StoryStatus } from "./types.js";

const RALPH_DIR = ".omni/state/ralph";
const PRDS_DIR = join(RALPH_DIR, "prds");
const COMPLETED_PRDS_DIR = join(RALPH_DIR, "completed-prds");

/**
 * Get the path to a PRD directory
 */
function getPRDPath(name: string, completed = false): string {
	const baseDir = completed ? COMPLETED_PRDS_DIR : PRDS_DIR;
	return join(process.cwd(), baseDir, name);
}

/**
 * Get the path to a PRD file
 */
function getPRDFilePath(name: string, completed = false): string {
	return join(getPRDPath(name, completed), "prd.json");
}

/**
 * Get the path to a progress file
 */
function getProgressFilePath(name: string, completed = false): string {
	return join(getPRDPath(name, completed), "progress.txt");
}

/**
 * Get the path to the spec file
 */
function getSpecFilePath(name: string, completed = false): string {
	return join(getPRDPath(name, completed), "spec.md");
}

/**
 * List all PRDs (active and optionally completed)
 */
export async function listPRDs(includeCompleted = false): Promise<string[]> {
	const prdsPath = join(process.cwd(), PRDS_DIR);
	const prdNames: string[] = [];

	// List active PRDs
	if (existsSync(prdsPath)) {
		const entries = readdirSync(prdsPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				prdNames.push(entry.name);
			}
		}
	}

	// List completed PRDs if requested
	if (includeCompleted) {
		const completedPath = join(process.cwd(), COMPLETED_PRDS_DIR);
		if (existsSync(completedPath)) {
			const entries = readdirSync(completedPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					prdNames.push(`${entry.name} (completed)`);
				}
			}
		}
	}

	return prdNames;
}

/**
 * Get a PRD by name
 */
export async function getPRD(name: string): Promise<PRD> {
	// Try active PRDs first
	let prdPath = getPRDFilePath(name, false);

	// If not found, try completed PRDs
	if (!existsSync(prdPath)) {
		prdPath = getPRDFilePath(name, true);
		if (!existsSync(prdPath)) {
			throw new Error(`PRD not found: ${name}`);
		}
	}

	const content = await Bun.file(prdPath).text();
	const prd = JSON.parse(content) as PRD;

	// Validate PRD structure
	if (prd.name === undefined || prd.description === undefined || prd.stories === undefined) {
		throw new Error(`Invalid PRD structure: ${name}`);
	}

	return prd;
}

/**
 * Update an existing PRD
 */
export async function updatePRD(name: string, updates: Partial<PRD>): Promise<PRD> {
	const existingPRD = await getPRD(name);

	const updatedPRD: PRD = {
		...existingPRD,
		...updates,
		name: existingPRD.name, // Ensure name doesn't change
	};

	const prdPath = getPRDFilePath(name, false);
	await Bun.write(prdPath, JSON.stringify(updatedPRD, null, 2));

	return updatedPRD;
}

/**
 * Archive a PRD (move to completed-prds/)
 */
export async function archivePRD(name: string): Promise<void> {
	const activePath = getPRDPath(name, false);

	if (!existsSync(activePath)) {
		throw new Error(`PRD not found: ${name}`);
	}

	// Create completed PRDs directory if it doesn't exist
	const completedDir = join(process.cwd(), COMPLETED_PRDS_DIR);
	mkdirSync(completedDir, { recursive: true });

	// Generate archive name with timestamp
	const timestamp = new Date().toISOString().split("T")[0];
	const archiveName = `${timestamp}-${name}`;
	const completedPath = getPRDPath(archiveName, true);

	if (existsSync(completedPath)) {
		throw new Error(`Archive already exists: ${archiveName}`);
	}

	const { renameSync } = await import("node:fs");
	renameSync(activePath, completedPath);
}

/**
 * Get the next pending story from a PRD (sorted by priority)
 */
export async function getNextStory(prdName: string): Promise<Story | null> {
	const prd = await getPRD(prdName);

	// Find stories that are pending or in_progress, sorted by priority
	const workableStories = prd.stories
		.filter((story) => story.status === "pending" || story.status === "in_progress")
		.sort((a, b) => a.priority - b.priority);

	return workableStories[0] ?? null;
}

/**
 * Update a story's status
 */
export async function updateStoryStatus(
	prdName: string,
	storyId: string,
	status: StoryStatus,
	questions?: string[],
): Promise<void> {
	const prd = await getPRD(prdName);

	const story = prd.stories.find((s) => s.id === storyId);
	if (!story) {
		throw new Error(`Story not found: ${storyId}`);
	}

	story.status = status;
	if (questions !== undefined) {
		story.questions = questions;
	}

	await updatePRD(prdName, { stories: prd.stories });
}

/**
 * Update the lastRun field in PRD
 */
export async function updateLastRun(prdName: string, lastRun: LastRun): Promise<void> {
	await updatePRD(prdName, { lastRun });
}

/**
 * Append content to the progress log
 */
export async function appendProgress(prdName: string, content: string): Promise<void> {
	const progressPath = getProgressFilePath(prdName, false);

	let existingContent = "";
	if (existsSync(progressPath)) {
		existingContent = await Bun.file(progressPath).text();
	}

	const updatedContent = `${existingContent}\n${content}\n`;
	await Bun.write(progressPath, updatedContent);
}

/**
 * Get the progress log content
 */
export async function getProgress(prdName: string): Promise<string> {
	const progressPath = getProgressFilePath(prdName, false);

	if (!existsSync(progressPath)) {
		return "";
	}

	return await Bun.file(progressPath).text();
}

/**
 * Get the spec file content
 */
export async function getSpec(prdName: string): Promise<string> {
	const specPath = getSpecFilePath(prdName, false);

	if (!existsSync(specPath)) {
		throw new Error(`Spec file not found for PRD: ${prdName}`);
	}

	return await Bun.file(specPath).text();
}

/**
 * Check if all stories in a PRD are completed
 */
export async function isPRDComplete(prdName: string): Promise<boolean> {
	const prd = await getPRD(prdName);
	return prd.stories.every((story) => story.status === "completed");
}

/**
 * Check if any stories are blocked
 */
export async function hasBlockedStories(prdName: string): Promise<Story[]> {
	const prd = await getPRD(prdName);
	return prd.stories.filter((story) => story.status === "blocked");
}

/**
 * Check if a PRD is complete (either archived or all stories completed)
 */
export async function isPRDCompleteOrArchived(prdName: string): Promise<boolean> {
	// Check if it's in the completed-prds folder
	const completedPath = getPRDFilePath(prdName, true);
	if (existsSync(completedPath)) {
		return true;
	}

	// Also check for date-prefixed archives (e.g., "2026-01-10-feature")
	const completedDir = join(process.cwd(), COMPLETED_PRDS_DIR);
	if (existsSync(completedDir)) {
		const entries = readdirSync(completedDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.endsWith(`-${prdName}`)) {
				return true;
			}
		}
	}

	// Check if it's in active PRDs and all stories are complete
	const activePath = getPRDFilePath(prdName, false);
	if (existsSync(activePath)) {
		return await isPRDComplete(prdName);
	}

	return false;
}

/**
 * Get unmet dependencies for a PRD
 * Returns array of dependency names that are not yet complete
 */
export async function getUnmetDependencies(prdName: string): Promise<string[]> {
	const prd = await getPRD(prdName);
	const dependencies = prd.dependencies ?? [];

	if (dependencies.length === 0) {
		return [];
	}

	const unmet: string[] = [];
	for (const dep of dependencies) {
		const isComplete = await isPRDCompleteOrArchived(dep);
		if (!isComplete) {
			unmet.push(dep);
		}
	}

	return unmet;
}

/**
 * Check if a PRD can be started (all dependencies complete)
 */
export async function canStartPRD(
	prdName: string,
): Promise<{ canStart: boolean; unmetDependencies: string[] }> {
	const unmetDependencies = await getUnmetDependencies(prdName);
	return {
		canStart: unmetDependencies.length === 0,
		unmetDependencies,
	};
}

/**
 * Dependency information for a single PRD
 */
export interface DependencyInfo {
	name: string;
	dependencies: string[];
	isComplete: boolean;
	canStart: boolean;
	unmetDependencies: string[];
}

/**
 * Build dependency graph for all active PRDs
 */
export async function buildDependencyGraph(): Promise<DependencyInfo[]> {
	const prdNames = await listPRDs(false);
	const graph: DependencyInfo[] = [];

	for (const name of prdNames) {
		try {
			const prd = await getPRD(name);
			const isComplete = await isPRDComplete(name);
			const { canStart, unmetDependencies } = await canStartPRD(name);

			graph.push({
				name,
				dependencies: prd.dependencies ?? [],
				isComplete,
				canStart,
				unmetDependencies,
			});
		} catch {
			// Skip invalid PRDs
		}
	}

	return graph;
}
