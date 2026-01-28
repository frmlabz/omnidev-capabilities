/**
 * Ralph CLI Commands
 *
 * Simple CLI for Ralph orchestration:
 * - list: List all PRDs with status
 * - status: Detailed status of one PRD
 * - start: Start orchestration (Ctrl+C to stop)
 * - progress: View progress log
 * - prd: PRD management commands
 * - spec: Spec file commands
 * - complete: Complete a PRD (extract findings via LLM and move to completed)
 * - test: Run automated tests for a PRD
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { command, routes } from "@omnidev-ai/capability";

const debug = (_msg: string, _ctx?: Record<string, unknown>) => {};
import {
	buildDependencyGraph,
	canStartPRD,
	extractAndSaveFindings,
	findPRDLocation,
	getProgress,
	getSpec,
	listPRDsByStatus,
	movePRD,
	unblockStory,
} from "./state.js";
import type { PRD, PRDStatus, Story } from "./types";

const RALPH_DIR = ".omni/state/ralph";
const PRDS_DIR = join(RALPH_DIR, "prds");

const STATUS_EMOJI: Record<PRDStatus, string> = {
	pending: "🟡",
	testing: "🔵",
	completed: "✅",
};

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
 * List all PRDs with status summary and dependency information
 */
export async function runList(flags: Record<string, unknown>): Promise<void> {
	debug("runList called", { cwd: process.cwd(), PRDS_DIR });

	const statusFilter =
		typeof flags["status"] === "string" ? (flags["status"] as PRDStatus) : undefined;
	const showAll = flags["all"] === true;

	let prds = await listPRDsByStatus(statusFilter);

	// By default, exclude completed PRDs unless --all is specified or a specific status is requested
	if (!showAll && !statusFilter) {
		prds = prds.filter((p) => p.status !== "completed");
	}

	if (prds.length === 0) {
		if (!showAll && !statusFilter) {
			console.log("No active PRDs found.");
			console.log(
				"\nUse --all to include completed PRDs, or create a new PRD using the /prd skill.",
			);
		} else {
			console.log("No PRDs found.");
			console.log("\nCreate a PRD using the /prd skill.");
		}
		return;
	}

	// Build dependency graph for all PRDs
	const depGraph = await buildDependencyGraph();

	console.log("\n=== Ralph PRDs ===\n");

	// Sort: pending first (runnable), then testing, completed
	const statusOrder: Record<PRDStatus, number> = { pending: 0, testing: 1, completed: 2 };
	const sortedPrds = [...prds].sort((a, b) => {
		const statusDiff = statusOrder[a.status] - statusOrder[b.status];
		if (statusDiff !== 0) return statusDiff;

		// Within pending, sort by runnability
		if (a.status === "pending") {
			const aInfo = depGraph.find((d) => d.name === a.name);
			const bInfo = depGraph.find((d) => d.name === b.name);
			if (aInfo?.canStart && !bInfo?.canStart) return -1;
			if (!aInfo?.canStart && bInfo?.canStart) return 1;
		}

		return a.name.localeCompare(b.name);
	});

	for (const { name, status } of sortedPrds) {
		const prdDir = join(PRDS_DIR, status, name);
		const prdPath = join(prdDir, "prd.json");
		if (!existsSync(prdPath)) continue;

		try {
			const prd: PRD = JSON.parse(await readFile(prdPath, "utf-8"));
			const depInfo = depGraph.find((d) => d.name === name);
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

			// Show status emoji and runnable indicator
			const statusEmoji = STATUS_EMOJI[status];
			let runnableIndicator = "";
			if (status === "pending") {
				if (blocked > 0) {
					runnableIndicator = " 🚫";
				} else if (depInfo?.canStart) {
					runnableIndicator = " 🟢";
				} else {
					runnableIndicator = " 🔒";
				}
			}

			console.log(`${statusEmoji} ${prd.name} ${progressBar} - ${statusStr}${runnableIndicator}`);
			console.log(`  ${prd.description}`);

			// Show dependencies if any (only for pending)
			if (status === "pending") {
				const deps = prd.dependencies ?? [];
				if (deps.length > 0) {
					const unmet = depInfo?.unmetDependencies ?? [];
					const depDisplay = deps
						.map((d) => (unmet.includes(d) ? `${d} (pending)` : `${d} ✓`))
						.join(", ");
					console.log(`  Dependencies: ${depDisplay}`);
				}
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
			console.log(`${name} - (invalid prd.json)`);
		}
	}

	console.log(
		"Legend: 🟡 Pending | 🔵 Testing | ✅ Completed | 🟢 Ready | 🔒 Blocked | 🚫 Has blocked stories",
	);
}

/**
 * Show detailed status of one PRD
 */
export async function runStatus(_flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		await runList({});
		return;
	}

	const status = findPRDLocation(prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		console.error(`\nAvailable PRDs:`);
		await runList({});
		return;
	}

	const prdPath = join(PRDS_DIR, status, prdName, "prd.json");
	const prd: PRD = JSON.parse(await readFile(prdPath, "utf-8"));
	const { canStart, unmetDependencies } = await canStartPRD(prdName);

	console.log(`\n=== ${prd.name} ===`);
	console.log(`Status: ${STATUS_EMOJI[status]} ${status}`);
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
			const depStatus = unmetDependencies.includes(dep) ? "⏳ pending" : "✅ complete";
			console.log(`  - ${dep}: ${depStatus}`);
		}
	}

	// Show runnable status (only for pending)
	if (status === "pending") {
		if (!canStart) {
			console.log(`\n🔒 Cannot start - waiting on: ${unmetDependencies.join(", ")}`);
		} else {
			console.log(`\n🟢 Ready to start`);
		}
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
	const specPath = join(PRDS_DIR, status, prdName, "spec.md");
	if (existsSync(specPath)) {
		console.log(`\nSpec: ${specPath}`);
	} else {
		console.log(`\n⚠️  Missing spec.md file!`);
	}
}

/**
 * Start Ralph orchestration
 */
export async function runStart(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph start <prd-name> [--agent <agent-name>]");
		console.error("\nAvailable PRDs:");
		await runList({});
		process.exit(1);
	}

	const agentOverride = typeof flags["agent"] === "string" ? flags["agent"] : undefined;

	const status = findPRDLocation(prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	if (status !== "pending") {
		console.error(`\n⚠️  PRD "${prdName}" is in ${status} status.`);
		console.error(`Only PRDs in 'pending' status can be started.`);
		if (status === "testing") {
			console.error(`\nTo continue work, move it back to pending:`);
			console.error(`  omnidev ralph prd ${prdName} --move pending`);
		}
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
	await runOrchestration(prdName, agentOverride);
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
		await runList({});
		process.exit(1);
	}

	const content = await getProgress(prdName);
	if (!content) {
		console.log(`No progress log found for: ${prdName}`);
		return;
	}

	const tail = typeof flags["tail"] === "number" ? flags["tail"] : undefined;
	if (tail) {
		const lines = content.split("\n");
		console.log(lines.slice(-tail).join("\n"));
	} else {
		console.log(content);
	}
}

/**
 * PRD management command
 */
export async function runPrd(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	// If no name, list PRDs
	if (!prdName || typeof prdName !== "string") {
		await runList(flags);
		return;
	}

	const moveToStatus = flags["move"] as PRDStatus | undefined;
	const edit = flags["edit"] as boolean | undefined;
	const extractFindingsFlag = flags["extract-findings"] as boolean | undefined;

	// Handle --move
	if (moveToStatus) {
		const validStatuses: PRDStatus[] = ["pending", "testing", "completed"];
		if (!validStatuses.includes(moveToStatus)) {
			console.error(`Invalid status: ${moveToStatus}`);
			console.error(`Valid statuses: ${validStatuses.join(", ")}`);
			process.exit(1);
		}

		const currentStatus = findPRDLocation(prdName);
		if (!currentStatus) {
			console.error(`PRD not found: ${prdName}`);
			process.exit(1);
		}

		if (currentStatus === moveToStatus) {
			console.log(`PRD "${prdName}" is already in ${moveToStatus}`);
			return;
		}

		// If moving to completed, extract findings first
		if (moveToStatus === "completed") {
			console.log("Extracting findings...");
			await extractAndSaveFindings(prdName);
		}

		await movePRD(prdName, moveToStatus);
		console.log(`Moved "${prdName}" from ${currentStatus} to ${moveToStatus}`);
		return;
	}

	// Handle --extract-findings
	if (extractFindingsFlag) {
		const status = findPRDLocation(prdName);
		if (!status) {
			console.error(`PRD not found: ${prdName}`);
			process.exit(1);
		}

		console.log(`Extracting findings from "${prdName}"...`);
		await extractAndSaveFindings(prdName);
		console.log("Findings extracted to .omni/state/ralph/findings.md");
		return;
	}

	// Handle --edit (placeholder - would launch editor)
	if (edit) {
		console.log(`Edit mode for "${prdName}" not yet implemented.`);
		console.log("Use your preferred editor to modify the PRD files.");
		return;
	}

	// Default: show PRD details
	await runStatus({}, prdName);
}

/**
 * Spec file command
 */
export async function runSpec(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph spec <prd-name>");
		console.error("\nAvailable PRDs:");
		await runList({});
		process.exit(1);
	}

	const status = findPRDLocation(prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	const edit = flags["edit"] as boolean | undefined;

	// Handle --edit (placeholder)
	if (edit) {
		console.log(`Edit mode for spec not yet implemented.`);
		console.log("Use your preferred editor to modify the spec file.");
		return;
	}

	// Default: show spec content
	try {
		const content = await getSpec(prdName);
		console.log(content);
	} catch (e) {
		console.error(`Error reading spec: ${e}`);
		process.exit(1);
	}
}

// Build commands
const listCommand = command({
	brief: "List all PRDs with status summary",
	parameters: {
		flags: {
			status: {
				kind: "string",
				brief: "Filter by status (pending, testing, completed)",
				optional: true,
			},
			all: {
				kind: "boolean",
				brief: "Include completed PRDs (excluded by default)",
				optional: true,
			},
		},
	},
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
		flags: {
			agent: {
				kind: "string",
				brief: "Agent to use (e.g., claude, codex, amp)",
				optional: true,
			},
		},
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

const prdCommand = command({
	brief: "PRD management (view, move, extract findings)",
	parameters: {
		flags: {
			move: {
				kind: "string",
				brief: "Move PRD to status (pending, testing, completed, archived)",
				optional: true,
			},
			edit: {
				kind: "boolean",
				brief: "Launch AI editor for PRD",
				optional: true,
			},
			"extract-findings": {
				kind: "boolean",
				brief: "Extract findings from PRD to findings.md",
				optional: true,
			},
		},
		positional: [
			{ brief: "PRD name (optional - lists PRDs if omitted)", kind: "string", optional: true },
		],
	},
	func: runPrd,
});

const specCommand = command({
	brief: "View or edit spec file",
	parameters: {
		flags: {
			edit: {
				kind: "boolean",
				brief: "Launch AI editor for spec",
				optional: true,
			},
		},
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runSpec,
});

/**
 * Complete a PRD - extract findings via LLM and move to completed
 */
export async function runComplete(
	_flags: Record<string, unknown>,
	prdName?: unknown,
): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph complete <prd-name>");
		console.error("\nAvailable PRDs in testing:");
		const prds = await listPRDsByStatus("testing");
		if (prds.length === 0) {
			console.log("  (none)");
		} else {
			for (const { name } of prds) {
				console.log(`  - ${name}`);
			}
		}
		process.exit(1);
	}

	const status = findPRDLocation(prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	if (status !== "testing") {
		console.error(`\n⚠️  PRD "${prdName}" is in ${status} status.`);
		console.error(`Only PRDs in 'testing' status can be completed.`);
		if (status === "pending") {
			console.error(`\nFirst finish all stories and move to testing:`);
			console.error(`  omnidev ralph start ${prdName}`);
		}
		process.exit(1);
	}

	console.log(`Completing PRD: ${prdName}`);

	// Load config and run LLM to extract findings
	const { loadRalphConfig, runAgent } = await import("./orchestrator.js");

	try {
		const config = await loadRalphConfig();
		const agentConfig = config.agents[config.default_agent];

		if (!agentConfig) {
			console.error(`Agent '${config.default_agent}' not found in config.`);
			process.exit(1);
		}

		console.log("Extracting findings via LLM...");
		await extractAndSaveFindings(prdName, agentConfig, runAgent);
		console.log("Findings saved to .omni/state/ralph/findings.md");

		console.log("Moving PRD to completed...");
		await movePRD(prdName, "completed");

		console.log(`\n✅ PRD "${prdName}" completed!`);
		console.log(`\nFindings have been extracted and saved.`);
		console.log(`View findings: cat .omni/state/ralph/findings.md`);
	} catch (error) {
		console.error(`\nError completing PRD: ${error}`);
		process.exit(1);
	}
}

const completeCommand = command({
	brief: "Complete a PRD - extract findings via LLM and move to completed",
	parameters: {
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runComplete,
});

/**
 * Run tests for a PRD
 */
export async function runTest(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph test <prd-name> [--agent <agent-name>]");
		console.error("\nAvailable PRDs in testing:");
		const prds = await listPRDsByStatus("testing");
		if (prds.length === 0) {
			console.log("  (none in testing status)");
			console.log("\nPRDs in pending:");
			const pendingPrds = await listPRDsByStatus("pending");
			for (const { name } of pendingPrds) {
				console.log(`  - ${name}`);
			}
		} else {
			for (const { name } of prds) {
				console.log(`  - ${name}`);
			}
		}
		process.exit(1);
	}

	const agentOverride = typeof flags["agent"] === "string" ? flags["agent"] : undefined;

	const status = findPRDLocation(prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	// Import and run testing
	const { runTesting } = await import("./testing.js");

	try {
		const { result } = await runTesting(prdName, agentOverride);

		// Exit codes based on result
		if (result === "verified") {
			// Success - PRD completed automatically
			process.exit(0);
		} else if (result === "failed") {
			// Failed - fix story created, moved to pending
			process.exit(1);
		} else {
			// Unknown - manual action needed
			process.exit(2);
		}
	} catch (error) {
		console.error(`\nError running tests: ${error}`);
		process.exit(1);
	}
}

const testCommand = command({
	brief: "Run verification tests for a PRD",
	parameters: {
		flags: {
			agent: {
				kind: "string",
				brief: "Agent to use (e.g., claude, codex, amp)",
				optional: true,
			},
		},
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runTest,
});

// Export route map
export const ralphRoutes = routes({
	brief: "Ralph AI orchestrator",
	routes: {
		list: listCommand,
		status: statusCommand,
		start: startCommand,
		progress: progressCommand,
		prd: prdCommand,
		spec: specCommand,
		complete: completeCommand,
		test: testCommand,
	},
});
