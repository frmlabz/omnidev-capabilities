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
 * - swarm: Parallel PRD execution via worktrees + tmux
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { command, routes } from "@omnidev-ai/capability";

import {
	buildDependencyGraph,
	canStartPRD,
	extractAndSaveFindings,
	findPRDLocation,
	getProgress,
	getSpec,
	hasPRDFile,
	listPRDsByStatus,
	movePRD,
	unblockStory,
	loadConfig,
} from "./lib/index.js";
import { getStatusDir } from "./lib/core/paths.js";
import type { PRD, PRDStatus, Story } from "./lib/types.js";

/**
 * Resolve projectName + repoRoot from config and git. Cached per process.
 */
let _projectCtx: { projectName: string; repoRoot: string } | null = null;
async function getProjectContext(): Promise<{ projectName: string; repoRoot: string }> {
	if (_projectCtx) return _projectCtx;
	const configResult = await loadConfig();
	if (!configResult.ok) {
		console.error(configResult.error!.message);
		process.exit(1);
	}
	const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
	_projectCtx = { projectName: configResult.data!.project_name, repoRoot };
	return _projectCtx;
}

const STATUS_EMOJI: Record<PRDStatus, string> = {
	pending: "🟡",
	in_progress: "🔵",
	testing: "🟣",
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
async function promptForAnswers(
	projectName: string,
	repoRoot: string,
	prdName: string,
	story: Story,
): Promise<void> {
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
		await unblockStory(projectName, repoRoot, prdName, story.id, answers);
		console.log(`✅ Story ${story.id} has been unblocked!\n`);
	} finally {
		rl.close();
	}
}

/**
 * List all PRDs with status summary and dependency information
 */
export async function runList(flags: Record<string, unknown>): Promise<void> {
	const { projectName, repoRoot } = await getProjectContext();

	const statusFilter =
		typeof flags["status"] === "string" ? (flags["status"] as PRDStatus) : undefined;
	const showAll = flags["all"] === true;

	let prds = await listPRDsByStatus(projectName, repoRoot, statusFilter);

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
	const depGraph = await buildDependencyGraph(projectName, repoRoot);

	console.log("\n=== Ralph PRDs ===\n");

	// Sort: pending first (runnable), then in_progress, testing, completed
	const statusOrder: Record<PRDStatus, number> = {
		pending: 0,
		in_progress: 1,
		testing: 2,
		completed: 3,
	};
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
		const prdDir = join(getStatusDir(projectName, repoRoot, status), name);
		const prdPath = join(prdDir, "prd.json");

		// Spec-only PRD (no prd.json yet — still in creation)
		if (!existsSync(prdPath)) {
			const statusEmoji = STATUS_EMOJI[status];
			console.log(`${statusEmoji} ${name} [spec only] - awaiting story creation`);
			console.log(`  Use /prd to complete story breakdown, or: omnidev ralph spec ${name}`);
			console.log();
			continue;
		}

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
		"Legend: 🟡 Pending | 🔵 In Progress | 🟣 Testing | ✅ Completed | 🟢 Ready | 🔒 Blocked | 🚫 Has blocked stories",
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

	const { projectName, repoRoot } = await getProjectContext();
	const status = findPRDLocation(projectName, repoRoot, prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		console.error(`\nAvailable PRDs:`);
		await runList({});
		return;
	}

	const prdDir = join(getStatusDir(projectName, repoRoot, status), prdName);
	const prdPath = join(prdDir, "prd.json");

	// Spec-only PRD (no prd.json yet)
	if (!existsSync(prdPath)) {
		console.log(`\n=== ${prdName} ===`);
		console.log(`Status: ${STATUS_EMOJI[status]} ${status} (spec only)`);
		console.log(`\nThis PRD only has a spec.md — stories have not been created yet.`);
		console.log(`Use /prd to complete story breakdown.`);

		const specPath = join(prdDir, "spec.md");
		if (existsSync(specPath)) {
			console.log(`\nSpec: ${specPath}`);
		}
		return;
	}

	const prd: PRD = JSON.parse(await readFile(prdPath, "utf-8"));
	const { canStart, unmetDependencies } = await canStartPRD(projectName, repoRoot, prdName);

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
	const specPath = join(getStatusDir(projectName, repoRoot, status), prdName, "spec.md");
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

	const { projectName, repoRoot } = await getProjectContext();
	const status = findPRDLocation(projectName, repoRoot, prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	if (!hasPRDFile(projectName, repoRoot, prdName)) {
		console.error(`\n⚠️  PRD "${prdName}" only has a spec — no stories defined yet.`);
		console.error(`Complete the PRD creation first using /prd, then start.`);
		process.exit(1);
	}

	if (status !== "pending" && status !== "in_progress") {
		console.error(`\n⚠️  PRD "${prdName}" is in ${status} status.`);
		console.error(`Only PRDs in 'pending' or 'in_progress' status can be started.`);
		if (status === "testing") {
			console.error(`\nTo continue work, move it back to in_progress:`);
			console.error(`  omnidev ralph prd ${prdName} --move in_progress`);
		}
		process.exit(1);
	}

	// Move from pending to in_progress if needed
	if (status === "pending") {
		await movePRD(projectName, repoRoot, prdName, "in_progress");
		console.log(`Moved PRD to in_progress\n`);
	}

	// Check dependencies before starting
	const { canStart, unmetDependencies } = await canStartPRD(projectName, repoRoot, prdName);
	if (!canStart) {
		console.error(`\n🔒 Cannot start "${prdName}" - has unmet dependencies:\n`);
		for (const dep of unmetDependencies) {
			console.error(`  - ${dep} (pending)`);
		}
		console.error(`\nComplete these PRDs first, then try again.`);
		process.exit(1);
	}

	// Check for blocked stories before starting
	const { hasBlockedStories: hasBlockedStoriesFn } = await import("./lib/index.js");
	const blockedStories = await hasBlockedStoriesFn(projectName, repoRoot, prdName);

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
						await promptForAnswers(projectName, repoRoot, prdName, story);
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
	const { runOrchestration } = await import("./lib/index.js");
	await runOrchestration(projectName, repoRoot, prdName, agentOverride);
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

	const { projectName, repoRoot } = await getProjectContext();
	const content = await getProgress(projectName, repoRoot, prdName);
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

	const { projectName, repoRoot } = await getProjectContext();
	const moveToStatus = flags["move"] as PRDStatus | undefined;
	const edit = flags["edit"] as boolean | undefined;
	const extractFindingsFlag = flags["extract-findings"] as boolean | undefined;

	// Handle --move
	if (moveToStatus) {
		const validStatuses: PRDStatus[] = ["pending", "in_progress", "testing", "completed"];
		if (!validStatuses.includes(moveToStatus)) {
			console.error(`Invalid status: ${moveToStatus}`);
			console.error(`Valid statuses: ${validStatuses.join(", ")}`);
			process.exit(1);
		}

		const currentStatus = findPRDLocation(projectName, repoRoot, prdName);
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
			await extractAndSaveFindings(projectName, repoRoot, prdName);
		}

		await movePRD(projectName, repoRoot, prdName, moveToStatus);
		console.log(`Moved "${prdName}" from ${currentStatus} to ${moveToStatus}`);
		return;
	}

	// Handle --extract-findings
	if (extractFindingsFlag) {
		const status = findPRDLocation(projectName, repoRoot, prdName);
		if (!status) {
			console.error(`PRD not found: ${prdName}`);
			process.exit(1);
		}

		if (!hasPRDFile(projectName, repoRoot, prdName)) {
			console.error(`\n⚠️  PRD "${prdName}" only has a spec — no stories to extract findings from.`);
			process.exit(1);
		}

		console.log(`Extracting findings from "${prdName}"...`);
		await extractAndSaveFindings(projectName, repoRoot, prdName);
		console.log(`Findings extracted to PRD directory`);
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

	const { projectName, repoRoot } = await getProjectContext();
	const status = findPRDLocation(projectName, repoRoot, prdName);
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
		const content = await getSpec(projectName, repoRoot, prdName);
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
				brief: "Extract findings from PRD progress to per-PRD findings.md",
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
	const { projectName, repoRoot } = await getProjectContext();

	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph complete <prd-name>");
		console.error("\nAvailable PRDs in testing:");
		const prds = await listPRDsByStatus(projectName, repoRoot, "testing");
		if (prds.length === 0) {
			console.log("  (none)");
		} else {
			for (const { name } of prds) {
				console.log(`  - ${name}`);
			}
		}
		process.exit(1);
	}

	const status = findPRDLocation(projectName, repoRoot, prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	if (!hasPRDFile(projectName, repoRoot, prdName)) {
		console.error(`\n⚠️  PRD "${prdName}" only has a spec — no stories defined yet.`);
		console.error(`Complete the PRD creation first using /prd.`);
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
	const { loadRalphConfig, runAgent } = await import("./lib/index.js");

	try {
		const config = await loadRalphConfig();
		const agentConfig = config.agents[config.default_agent];

		if (!agentConfig) {
			console.error(`Agent '${config.default_agent}' not found in config.`);
			process.exit(1);
		}

		console.log("Extracting findings via LLM...");
		await extractAndSaveFindings(projectName, repoRoot, prdName, agentConfig, runAgent);
		console.log("Findings saved to PRD directory");

		console.log("Moving PRD to completed...");
		await movePRD(projectName, repoRoot, prdName, "completed");

		console.log(`\n✅ PRD "${prdName}" completed!`);
		console.log(`\nFindings have been extracted and saved.`);
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
	const { projectName, repoRoot } = await getProjectContext();

	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph test <prd-name> [--agent <agent-name>]");
		console.error("\nAvailable PRDs in testing:");
		const prds = await listPRDsByStatus(projectName, repoRoot, "testing");
		if (prds.length === 0) {
			console.log("  (none in testing status)");
			console.log("\nPRDs in pending:");
			const pendingPrds = await listPRDsByStatus(projectName, repoRoot, "pending");
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

	const status = findPRDLocation(projectName, repoRoot, prdName);
	if (!status) {
		console.error(`PRD not found: ${prdName}`);
		process.exit(1);
	}

	if (!hasPRDFile(projectName, repoRoot, prdName)) {
		console.error(`\n⚠️  PRD "${prdName}" only has a spec — no stories defined yet.`);
		console.error(`Complete the PRD creation first using /prd.`);
		process.exit(1);
	}

	// Import and run testing
	const { runTesting } = await import("./lib/index.js");

	try {
		const { result } = await runTesting(projectName, repoRoot, prdName, agentOverride);

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

// ── Swarm commands ─────────────────────────────────────────────────────

/**
 * Create a SwarmManager from config. Shared by all swarm sub-commands.
 */
async function createSwarmManager() {
	const { getSwarmConfig } = await import("./lib/index.js");
	const { SwarmManager, TmuxSessionBackend } = await import("./lib/swarm/index.js");

	const { projectName, repoRoot } = await getProjectContext();
	const configResult = await loadConfig();
	if (!configResult.ok) {
		console.error(configResult.error!.message);
		process.exit(1);
	}
	const config = configResult.data!;

	const swarmConfig = getSwarmConfig(config);
	const session = new TmuxSessionBackend(swarmConfig.panes_per_window);
	return new SwarmManager(swarmConfig, session, projectName, projectName, repoRoot);
}

/**
 * Format a run instance for display
 */
function formatRunInstance(run: {
	prdName: string;
	status: string;
	worktree: string;
	paneId: string;
	startedAt: string;
	branch: string;
}) {
	const elapsed = formatDuration(run.startedAt);
	return `  ${run.prdName} [${run.status}] — ${elapsed} — pane: ${run.paneId}`;
}

async function runSwarmStart(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph swarm start <prd-name> [--agent <agent>]");
		process.exit(1);
	}

	const manager = await createSwarmManager();
	const agent = typeof flags["agent"] === "string" ? flags["agent"] : undefined;
	const result = await manager.start(prdName, { agent });

	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}

	const run = result.data!;
	console.log(`Started "${prdName}" in worktree: ${run.worktree}`);
	console.log(`  Pane: ${run.paneId} | Branch: ${run.branch}`);
}

async function runSwarmTest(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph swarm test <prd-name> [--agent <agent>]");
		process.exit(1);
	}

	const manager = await createSwarmManager();
	const agent = typeof flags["agent"] === "string" ? flags["agent"] : undefined;
	const result = await manager.test(prdName, { agent });

	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}

	console.log(`Testing "${prdName}" — pane: ${result.data!.paneId}`);
}

async function runSwarmStop(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	const manager = await createSwarmManager();

	if (flags["all"] === true) {
		const result = await manager.stopAll();
		if (!result.ok) {
			console.error(`Error: ${result.error!.message}`);
			process.exit(1);
		}
		console.log("All runs stopped.");
		return;
	}

	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph swarm stop <prd-name> | --all");
		process.exit(1);
	}

	const result = await manager.stop(prdName);
	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}
	console.log(`Stopped "${prdName}".`);
}

async function runSwarmList(_flags: Record<string, unknown>): Promise<void> {
	const manager = await createSwarmManager();
	const result = await manager.list();

	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}

	const runs = result.data!;
	if (runs.length === 0) {
		console.log("No active runs.");
		return;
	}

	console.log("\n=== Active Runs ===\n");
	for (const run of runs) {
		console.log(formatRunInstance(run));
	}
	console.log();
}

async function runSwarmAttach(_flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph swarm attach <prd-name>");
		process.exit(1);
	}

	const manager = await createSwarmManager();
	const result = await manager.attach(prdName);

	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}
}

async function runSwarmLogs(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph swarm logs <prd-name> [--tail <n>]");
		process.exit(1);
	}

	const manager = await createSwarmManager();
	const tail = typeof flags["tail"] === "number" ? flags["tail"] : 100;
	const result = await manager.logs(prdName, tail);

	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}

	console.log(result.data!);
}

async function runSwarmMerge(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	const manager = await createSwarmManager();

	if (flags["all"] === true) {
		const result = await manager.mergeAll();
		if (!result.ok) {
			console.error(`Error: ${result.error!.message}`);
			process.exit(1);
		}
		const merged = result.data!;
		if (merged.length === 0) {
			console.log("No runs to merge.");
		} else {
			for (const m of merged) {
				console.log(
					`Merged "${m.prdName}" — commit: ${m.commitSha.slice(0, 8)} — ${m.filesChanged.length} file(s)`,
				);
			}
		}
		return;
	}

	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph swarm merge <prd-name> | --all");
		process.exit(1);
	}

	const result = await manager.merge(prdName);
	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		if (result.error!.details?.["conflictFiles"]) {
			console.error("Conflicting files:");
			for (const f of result.error!.details["conflictFiles"] as string[]) {
				console.error(`  - ${f}`);
			}
		}
		process.exit(1);
	}

	const m = result.data!;
	console.log(
		`Merged "${m.prdName}" — commit: ${m.commitSha.slice(0, 8)} — ${m.filesChanged.length} file(s)`,
	);
}

async function runSwarmCleanup(flags: Record<string, unknown>, prdName?: unknown): Promise<void> {
	const manager = await createSwarmManager();

	if (flags["all"] === true) {
		const result = await manager.cleanupAll();
		if (!result.ok) {
			console.error(`Error: ${result.error!.message}`);
			process.exit(1);
		}
		console.log("All stale/stopped runs cleaned up.");
		return;
	}

	if (!prdName || typeof prdName !== "string") {
		console.error("Usage: omnidev ralph swarm cleanup <prd-name> | --all");
		process.exit(1);
	}

	const result = await manager.cleanup(prdName);
	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}
	console.log(`Cleaned up "${prdName}".`);
}

async function runSwarmRecover(_flags: Record<string, unknown>): Promise<void> {
	const manager = await createSwarmManager();
	const result = await manager.recover();

	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}

	const r = result.data!;
	if (r.recovered.length > 0) {
		console.log("Recovered (still running):");
		for (const inst of r.recovered) {
			console.log(`  ${inst.prdName} — pane: ${inst.paneId}`);
		}
	}
	if (r.orphaned.length > 0) {
		console.log("Orphaned (worktree exists, no session):");
		for (const o of r.orphaned) {
			console.log(`  ${o.prdName} — ${o.worktree}`);
		}
		console.log(
			"\nUse 'ralph swarm start <prd>' to restart or 'ralph swarm cleanup <prd>' to remove.",
		);
	}
	if (r.cleaned.length > 0) {
		console.log(`Cleaned stale entries: ${r.cleaned.join(", ")}`);
	}
	if (r.recovered.length === 0 && r.orphaned.length === 0 && r.cleaned.length === 0) {
		console.log("Nothing to recover.");
	}
}

async function runSwarmConflicts(_flags: Record<string, unknown>): Promise<void> {
	const manager = await createSwarmManager();
	const result = await manager.conflicts();

	if (!result.ok) {
		console.error(`Error: ${result.error!.message}`);
		process.exit(1);
	}

	const reports = result.data!;
	if (reports.length === 0) {
		console.log("No merge conflicts detected.");
		return;
	}

	console.log("\n=== Merge Conflicts ===\n");
	for (const r of reports) {
		console.log(`${r.prdName} (branch: ${r.branch}):`);
		for (const f of r.conflictFiles) {
			console.log(`  - ${f}`);
		}
		console.log();
	}
}

// Build run sub-commands
const swarmStartCommand = command({
	brief: "Start a PRD in a new worktree + tmux pane",
	parameters: {
		flags: {
			agent: { kind: "string", brief: "Agent to use", optional: true },
		},
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runSwarmStart,
});

const swarmTestCommand = command({
	brief: "Run tests for a PRD in its worktree",
	parameters: {
		flags: {
			agent: { kind: "string", brief: "Agent to use", optional: true },
		},
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runSwarmTest,
});

const swarmStopCommand = command({
	brief: "Stop a running PRD (sends interrupt)",
	parameters: {
		flags: {
			all: { kind: "boolean", brief: "Stop all running PRDs", optional: true },
		},
		positional: [{ brief: "PRD name", kind: "string", optional: true }],
	},
	func: runSwarmStop,
});

const swarmListCommand = command({
	brief: "List all active runs with status",
	parameters: {},
	func: runSwarmList,
});

const swarmAttachCommand = command({
	brief: "Focus a PRD's tmux pane",
	parameters: {
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runSwarmAttach,
});

const swarmLogsCommand = command({
	brief: "View recent output from a PRD's pane",
	parameters: {
		flags: {
			tail: { kind: "number", brief: "Number of lines (default: 100)", optional: true },
		},
		positional: [{ brief: "PRD name", kind: "string" }],
	},
	func: runSwarmLogs,
});

const swarmMergeCommand = command({
	brief: "Merge a PRD's branch into main",
	parameters: {
		flags: {
			all: { kind: "boolean", brief: "Merge all completed/stopped PRDs", optional: true },
		},
		positional: [{ brief: "PRD name", kind: "string", optional: true }],
	},
	func: runSwarmMerge,
});

const swarmCleanupCommand = command({
	brief: "Remove worktree + session resources without merging",
	parameters: {
		flags: {
			all: { kind: "boolean", brief: "Clean up all stale/stopped runs", optional: true },
		},
		positional: [{ brief: "PRD name", kind: "string", optional: true }],
	},
	func: runSwarmCleanup,
});

const swarmRecoverCommand = command({
	brief: "Recover from session loss (tmux died, etc.)",
	parameters: {},
	func: runSwarmRecover,
});

const swarmConflictsCommand = command({
	brief: "Check for merge conflicts across running PRDs",
	parameters: {},
	func: runSwarmConflicts,
});

const swarmRoutes = routes({
	brief: "Parallel PRD execution via worktrees + tmux",
	routes: {
		start: swarmStartCommand,
		test: swarmTestCommand,
		stop: swarmStopCommand,
		list: swarmListCommand,
		attach: swarmAttachCommand,
		logs: swarmLogsCommand,
		merge: swarmMergeCommand,
		cleanup: swarmCleanupCommand,
		recover: swarmRecoverCommand,
		conflicts: swarmConflictsCommand,
	},
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
		swarm: swarmRoutes,
	},
});
