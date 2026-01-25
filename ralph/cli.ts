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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { command, routes } from "@omnidev-ai/capability";

// TODO: import { debug } from "@omnidev-ai/capability" once package is redeployed
const debug = (_msg: string, _ctx?: Record<string, unknown>) => {};
import { buildDependencyGraph, canStartPRD, unblockStory } from "./state.js";
import type { PRD, Story } from "./types";

const RALPH_DIR = ".omni/state/ralph";
const PRDS_DIR = join(RALPH_DIR, "prds");

/**
 * Format duration between two ISO timestamps as human-readable string
 */
function formatDuration(startIso: string, endIso?: string): string {
	const start = new Date(startIso).getTime();
	const end = endIso ? new Date(endIso).getTime() : Date.now();
	const ms = end - start;

	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

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
			const prd: PRD = JSON.parse(await readFile(prdPath, "utf-8"));
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

			// Show runnable status - prioritize showing blocked status
			let runnableStatus: string;
			if (blocked > 0) {
				runnableStatus = "🚫"; // Show blocked if any stories are blocked
			} else if (depInfo?.isComplete) {
				runnableStatus = "✅";
			} else if (depInfo?.canStart) {
				runnableStatus = "🟢";
			} else {
				runnableStatus = "🔒";
			}

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

			// Show timing if started
			if (prd.startedAt) {
				const duration = formatDuration(prd.startedAt, prd.completedAt);
				const timingParts: string[] = [];
				if (prd.completedAt) {
					timingParts.push(`completed in ${duration}`);
				} else {
					timingParts.push(`in progress for ${duration}`);
				}
				if (prd.metrics?.iterations) {
					timingParts.push(`${prd.metrics.iterations} iterations`);
				}
				if (prd.metrics?.totalTokens) {
					timingParts.push(`${prd.metrics.totalTokens.toLocaleString()} tokens`);
				}
				console.log(`  Time: ${timingParts.join(", ")}`);
			}
			console.log();
		} catch {
			console.log(`${prdName} - (invalid prd.json)`);
		}
	}

	// Show legend
	console.log(
		"Legend: 🟢 Ready to start | 🚫 Has blocked stories | 🔒 Waiting on dependencies | ✅ Complete",
	);
}

/**
 * Interactively prompt user to answer questions for a blocked story
 */
async function promptForAnswers(prdName: string, story: Story): Promise<void> {
	console.log(`\n🚫 Story ${story.id} is blocked: ${story.title}\n`);
	console.log("Please answer the following questions to unblock:\n");

	const rl = readline.createInterface({ input, output });
	const answers: string[] = [];

	try {
		for (let i = 0; i < story.questions.length; i++) {
			const question = story.questions[i];
			console.log(`Question ${i + 1}/${story.questions.length}:`);
			console.log(`  ${question}\n`);
			const answer = await rl.question("Answer: ");
			answers.push(answer.trim());
			console.log();
		}

		// Save answers and unblock story
		await unblockStory(prdName, story.id, answers);
		console.log(`✅ Story ${story.id} has been unblocked!\n`);
	} finally {
		rl.close();
	}
}

/**
 * Show detailed status of one PRD
 */
export async function runStatus(_flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
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

	const prd: PRD = JSON.parse(await readFile(prdPath, "utf-8"));
	const { canStart, unmetDependencies } = await canStartPRD(prdName);

	console.log(`\n=== ${prd.name} ===`);
	console.log(`Description: ${prd.description}`);
	console.log(`Created: ${prd.createdAt}`);

	// Show timing info
	if (prd.startedAt) {
		console.log(`Started: ${prd.startedAt}`);
		if (prd.completedAt) {
			console.log(`Completed: ${prd.completedAt}`);
			console.log(`Duration: ${formatDuration(prd.startedAt, prd.completedAt)}`);
		} else {
			console.log(`Elapsed: ${formatDuration(prd.startedAt)} (in progress)`);
		}
	}

	// Show metrics if available
	if (prd.metrics) {
		const metricParts: string[] = [];
		if (prd.metrics.iterations) metricParts.push(`${prd.metrics.iterations} iterations`);
		if (prd.metrics.totalTokens)
			metricParts.push(`${prd.metrics.totalTokens.toLocaleString()} total tokens`);
		if (prd.metrics.inputTokens)
			metricParts.push(`${prd.metrics.inputTokens.toLocaleString()} input`);
		if (prd.metrics.outputTokens)
			metricParts.push(`${prd.metrics.outputTokens.toLocaleString()} output`);
		if (metricParts.length > 0) {
			console.log(`Metrics: ${metricParts.join(", ")}`);
		}
	}

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
			console.log(`     Questions:`);
			for (let i = 0; i < s.questions.length; i++) {
				const q = s.questions[i];
				const ans = s.answers?.[i];
				if (ans) {
					console.log(`       ${i + 1}. ${q}`);
					console.log(`          Answer: ${ans}`);
				} else {
					console.log(`       ${i + 1}. ${q}`);
				}
			}
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
export async function runStart(_flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
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

	// Check for blocked stories before starting
	const { hasBlockedStories } = await import("./state.js");
	const blockedStories = await hasBlockedStories(prdName);

	if (blockedStories.length > 0) {
		console.log(
			`\n🚫 Cannot start "${prdName}" - has ${blockedStories.length} blocked story(ies):\n`,
		);

		// Show all blocked stories
		for (const story of blockedStories) {
			console.log(`  ${story.id}: ${story.title}`);
			if (story.questions.length > 0) {
				console.log(`    Questions: ${story.questions.length}`);
			}
		}

		console.log("\nYou must unblock these stories before proceeding.\n");

		// Ask user if they want to answer questions now
		const rl = readline.createInterface({ input, output });
		try {
			const answer = await rl.question("Would you like to answer the questions now? (y/n): ");

			if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
				rl.close();
				// Prompt for answers for each blocked story
				for (const story of blockedStories) {
					if (story.questions.length > 0) {
						await promptForAnswers(prdName, story);
					}
				}
				console.log("All blocked stories have been addressed. Starting orchestration...\n");
			} else {
				rl.close();
				console.log("\nPlease unblock the stories manually, then try again.");
				console.log(`Use 'omnidev ralph status ${prdName}' to view blocked stories.`);
				process.exit(1);
			}
		} catch (error) {
			rl.close();
			throw error;
		}
	}

	// Import and run orchestration
	const { runOrchestration } = await import("./orchestrator.js");
	await runOrchestration(prdName);
}

/**
 * View progress log
 */
export async function runProgress(
	flags: Record<string, unknown>,
	prdName?: unknown,
): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
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

	const content = await readFile(progressPath, "utf-8");

	const tail = typeof flags["tail"] === "number" ? flags["tail"] : undefined;
	if (tail) {
		const lines = content.split("\n");
		console.log(lines.slice(-tail).join("\n"));
	} else {
		console.log(content);
	}
}

// Build commands
const listCommand = command({
	brief: "List all PRDs with status summary",
	func: runList,
});

const statusCommand = command({
	brief: "Show detailed status of a PRD",
	parameters: {
		positional: [
			{ brief: "PRD name (optional - shows list if omitted)", kind: "string", optional: true },
		],
	},
	func: runStatus,
});

const startCommand = command({
	brief: "Start Ralph orchestration (Ctrl+C to stop)",
	parameters: {
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runStart,
});

const progressCommand = command({
	brief: "View progress log",
	parameters: {
		flags: {
			tail: {
				kind: "number",
				brief: "Show last N lines",
				optional: true,
			},
		},
		positional: [
			{ brief: "PRD name (optional - shows error if omitted)", kind: "string", optional: true },
		],
	},
	func: runProgress,
});

// Export route map
export const ralphRoutes = routes({
	brief: "Ralph AI orchestrator",
	routes: {
		list: listCommand,
		status: statusCommand,
		start: startCommand,
		progress: progressCommand,
	},
});
