/**
 * Ralph CLI Commands
 *
 * Simple CLI for Ralph orchestration:
 * - list: List all PRDs with status
 * - status: Detailed status of one PRD
 * - start: Start orchestration (Ctrl+C to stop)
 * - progress: View progress log
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildCommand, buildRouteMap, debug } from "@omnidev-ai/core";
import { buildDependencyGraph, canStartPRD } from "./state.js";
import type { PRD, Story } from "./types";

const RALPH_DIR = ".omni/state/ralph";
const PRDS_DIR = join(RALPH_DIR, "prds");

/**
 * List all PRDs with status summary and dependency information
 */
export async function runList(): Promise<void> {
	debug("runList called", { cwd: process.cwd(), PRDS_DIR });

	if (!existsSync(PRDS_DIR)) {
		debug("PRDS_DIR does not exist", { PRDS_DIR });
		console.log("No PRDs found.");
		console.log("\nCreate a PRD using the /prd skill.");
		return;
	}

	const prdDirs = readdirSync(PRDS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	debug("Found PRD directories", { prdDirs });

	if (prdDirs.length === 0) {
		console.log("No PRDs found.");
		console.log("\nCreate a PRD using the /prd skill.");
		return;
	}

	// Build dependency graph for all PRDs
	const depGraph = await buildDependencyGraph();

	console.log("\n=== Ralph PRDs ===\n");

	// Sort: runnable PRDs first, then by name
	const sortedPrds = [...prdDirs].sort((a, b) => {
		const aInfo = depGraph.find((d) => d.name === a);
		const bInfo = depGraph.find((d) => d.name === b);
		// Runnable PRDs come first
		if (aInfo?.canStart && !bInfo?.canStart) return -1;
		if (!aInfo?.canStart && bInfo?.canStart) return 1;
		return a.localeCompare(b);
	});

	for (const prdName of sortedPrds) {
		const prdPath = join(PRDS_DIR, prdName, "prd.json");
		if (!existsSync(prdPath)) continue;

		try {
			const prd: PRD = await Bun.file(prdPath).json();
			const depInfo = depGraph.find((d) => d.name === prdName);
			const total = prd.stories.length;
			const completed = prd.stories.filter((s) => s.status === "completed").length;
			const inProgress = prd.stories.filter((s) => s.status === "in_progress").length;
			const blocked = prd.stories.filter((s) => s.status === "blocked").length;

			const statusParts: string[] = [];
			if (completed > 0) statusParts.push(`${completed} done`);
			if (inProgress > 0) statusParts.push(`${inProgress} in progress`);
			if (blocked > 0) statusParts.push(`${blocked} blocked`);

			const statusStr = statusParts.length > 0 ? statusParts.join(", ") : "not started";
			const progressBar = total > 0 ? `[${completed}/${total}]` : "[0/0]";

			// Show runnable status
			const runnableStatus = depInfo?.isComplete ? "✅" : depInfo?.canStart ? "🟢" : "🔒";

			console.log(`${runnableStatus} ${prd.name} ${progressBar} - ${statusStr}`);
			console.log(`  ${prd.description}`);

			// Show dependencies if any
			const deps = prd.dependencies ?? [];
			if (deps.length > 0) {
				const unmet = depInfo?.unmetDependencies ?? [];
				const depDisplay = deps
					.map((d) => (unmet.includes(d) ? `${d} (pending)` : `${d} ✓`))
					.join(", ");
				console.log(`  Dependencies: ${depDisplay}`);
			}
			console.log();
		} catch {
			console.log(`${prdName} - (invalid prd.json)`);
		}
	}

	// Show legend
	console.log("Legend: 🟢 Ready to start | 🔒 Waiting on dependencies | ✅ Complete");
}

/**
 * Show detailed status of one PRD
 */
export async function runStatus(_flags: Record<string, never>, prdName?: string): Promise<void> {
	if (!prdName) {
		// If no PRD specified, list them
		await runList();
		return;
	}

	const prdPath = join(PRDS_DIR, prdName, "prd.json");
	if (!existsSync(prdPath)) {
		console.error(`PRD not found: ${prdName}`);
		console.error(`\nAvailable PRDs:`);
		await runList();
		return;
	}

	const prd: PRD = await Bun.file(prdPath).json();
	const { canStart, unmetDependencies } = await canStartPRD(prdName);

	console.log(`\n=== ${prd.name} ===`);
	console.log(`Description: ${prd.description}`);
	console.log(`Created: ${prd.createdAt}`);

	// Show dependencies if any
	const deps = prd.dependencies ?? [];
	if (deps.length > 0) {
		console.log(`\nDependencies:`);
		for (const dep of deps) {
			const status = unmetDependencies.includes(dep) ? "⏳ pending" : "✅ complete";
			console.log(`  - ${dep}: ${status}`);
		}
	}

	// Show runnable status
	if (!canStart) {
		console.log(`\n🔒 Cannot start - waiting on: ${unmetDependencies.join(", ")}`);
	} else {
		console.log(`\n🟢 Ready to start`);
	}

	// Show last run info if available
	if (prd.lastRun) {
		console.log(`\nLast run: ${prd.lastRun.timestamp}`);
		console.log(`  Stopped at: ${prd.lastRun.storyId} (${prd.lastRun.reason})`);
		console.log(`  Summary: ${prd.lastRun.summary}`);
	}

	// Calculate progress
	const total = prd.stories.length;
	const completed = prd.stories.filter((s) => s.status === "completed").length;

	console.log(`\nProgress: ${completed}/${total} stories complete`);

	// Group stories by status
	const pending = prd.stories.filter((s) => s.status === "pending");
	const inProgress = prd.stories.filter((s) => s.status === "in_progress");
	const blocked = prd.stories.filter((s) => s.status === "blocked");
	const done = prd.stories.filter((s) => s.status === "completed");

	const printStory = (s: Story, prefix: string) => {
		console.log(`  ${prefix} ${s.id}: ${s.title} [priority: ${s.priority}]`);
		if (s.questions.length > 0) {
			console.log(`     Questions: ${s.questions.join("; ")}`);
		}
	};

	if (inProgress.length > 0) {
		console.log(`\n🔄 In Progress:`);
		inProgress.forEach((s) => {
			printStory(s, "→");
		});
	}

	if (blocked.length > 0) {
		console.log(`\n🚫 Blocked:`);
		blocked.forEach((s) => {
			printStory(s, "?");
		});
	}

	if (pending.length > 0) {
		console.log(`\n⏳ Pending:`);
		pending.forEach((s) => {
			printStory(s, "○");
		});
	}

	if (done.length > 0) {
		console.log(`\n✅ Completed:`);
		done.forEach((s) => {
			printStory(s, "✓");
		});
	}

	// Check for spec file
	const specPath = join(PRDS_DIR, prdName, "spec.md");
	if (existsSync(specPath)) {
		console.log(`\nSpec: ${specPath}`);
	} else {
		console.log(`\n⚠️  Missing spec.md file!`);
	}
}

/**
 * Start Ralph orchestration
 */
export async function runStart(_flags: Record<string, never>, prdName: string): Promise<void> {
	if (!prdName) {
		console.error("Usage: omnidev ralph start <prd-name>");
		console.error("\nAvailable PRDs:");
		await runList();
		process.exit(1);
	}

	const prdPath = join(PRDS_DIR, prdName, "prd.json");
	if (!existsSync(prdPath)) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	// Check dependencies before starting
	const { canStart, unmetDependencies } = await canStartPRD(prdName);
	if (!canStart) {
		console.error(`\n🔒 Cannot start "${prdName}" - has unmet dependencies:\n`);
		for (const dep of unmetDependencies) {
			console.error(`  - ${dep} (pending)`);
		}
		console.error(`\nComplete these PRDs first, then try again.`);
		process.exit(1);
	}

	// Import and run orchestration
	const { runOrchestration } = await import("./orchestrator.js");
	await runOrchestration(prdName);
}

/**
 * View progress log
 */
export async function runProgress(flags: { tail?: number }, prdName?: string): Promise<void> {
	if (!prdName) {
		console.error("Usage: omnidev ralph progress <prd-name>");
		console.error("\nAvailable PRDs:");
		await runList();
		process.exit(1);
	}

	const progressPath = join(PRDS_DIR, prdName, "progress.txt");
	if (!existsSync(progressPath)) {
		console.log(`No progress log found for: ${prdName}`);
		return;
	}

	const content = await Bun.file(progressPath).text();

	if (flags.tail) {
		const lines = content.split("\n");
		console.log(lines.slice(-flags.tail).join("\n"));
	} else {
		console.log(content);
	}
}

// Build commands
const listCommand = buildCommand({
	func: runList,
	parameters: {},
	docs: {
		brief: "List all PRDs with status summary",
	},
});

const statusCommand = buildCommand({
	func: runStatus,
	parameters: {
		flags: {},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "PRD name (optional - shows list if omitted)",
					parse: String,
					optional: true,
				},
			],
		},
	},
	docs: {
		brief: "Show detailed status of a PRD",
	},
});

const startCommand = buildCommand({
	func: runStart,
	parameters: {
		flags: {},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "PRD name",
					parse: String,
				},
			],
		},
	},
	docs: {
		brief: "Start Ralph orchestration (Ctrl+C to stop)",
	},
});

const progressCommand = buildCommand({
	func: runProgress,
	parameters: {
		flags: {
			tail: {
				kind: "parsed" as const,
				brief: "Show last N lines",
				parse: Number,
				optional: true,
			},
		},
		positional: {
			kind: "tuple" as const,
			parameters: [
				{
					brief: "PRD name (optional - shows error if omitted)",
					parse: String,
					optional: true,
				},
			],
		},
	},
	docs: {
		brief: "View progress log",
	},
});

// Export route map
export const ralphRoutes = buildRouteMap({
	routes: {
		list: listCommand,
		status: statusCommand,
		start: startCommand,
		progress: progressCommand,
	},
	docs: {
		brief: "Ralph AI orchestrator",
	},
});
