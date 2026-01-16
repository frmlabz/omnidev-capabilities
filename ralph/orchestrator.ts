/**
 * Ralph Orchestrator
 *
 * Handles agent spawning and iteration loops for PRD-driven development.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { generatePrompt } from "./prompt.ts";
import {
	archivePRD,
	getNextStory,
	getPRD,
	hasBlockedStories,
	isPRDComplete,
	updateLastRun,
	updateStoryStatus,
} from "./state.ts";
import type { AgentConfig, RalphConfig, Story } from "./types.d.ts";

const RALPH_DIR = ".omni/state/ralph";
const CONFIG_PATH = join(RALPH_DIR, "config.toml");

// Track current state for Ctrl+C handler
let currentPrdName: string | null = null;
let currentStory: Story | null = null;
let isShuttingDown = false;

/**
 * Loads Ralph configuration from .omni/ralph/config.toml
 */
export async function loadRalphConfig(): Promise<RalphConfig> {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error("Ralph config not found. Run 'omnidev sync' first.");
	}

	const content = await Bun.file(CONFIG_PATH).text();

	// Parse TOML manually (simple parser for our needs)
	const lines = content.split("\n");
	const config: Partial<RalphConfig> = {
		agents: {},
	};

	let currentSection: string | null = null;
	let currentAgent: string | null = null;

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip empty lines and comments
		if (trimmed === "" || trimmed.startsWith("#")) {
			continue;
		}

		// Section headers
		if (trimmed.startsWith("[")) {
			const match = trimmed.match(/^\[([^\]]+)\]$/);
			if (match) {
				const section = match[1];
				if (section === "ralph") {
					currentSection = "ralph";
					currentAgent = null;
				} else if (section?.startsWith("agents.")) {
					currentSection = "agents";
					currentAgent = section.slice("agents.".length);
					if (!config.agents) {
						config.agents = {};
					}
					config.agents[currentAgent] = { command: "", args: [] };
				}
			}
			continue;
		}

		// Key-value pairs
		const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
		if (match) {
			const [, key, value] = match;
			if (!key || !value) {
				continue;
			}

			if (currentSection === "ralph") {
				if (key === "default_agent") {
					config.default_agent = value.replace(/["']/g, "");
				} else if (key === "default_iterations") {
					config.default_iterations = Number.parseInt(value, 10);
				} else if (key === "auto_archive") {
					config.auto_archive = value === "true";
				}
			} else if (currentSection === "agents" && currentAgent) {
				const agent = config.agents?.[currentAgent];
				if (!agent) {
					continue;
				}

				if (key === "command") {
					agent.command = value.replace(/["']/g, "");
				} else if (key === "args") {
					// Parse array
					const arrayMatch = value.match(/\[(.*)\]/);
					if (arrayMatch?.[1]) {
						agent.args = arrayMatch[1].split(",").map((arg) => arg.trim().replace(/["']/g, ""));
					}
				}
			}
		}
	}

	// Validate required fields
	if (!config.default_agent || !config.default_iterations) {
		throw new Error("Invalid Ralph config: missing required fields");
	}

	return config as RalphConfig;
}

/**
 * Spawns an agent process with the given prompt.
 */
export async function runAgent(
	prompt: string,
	agentConfig: AgentConfig,
): Promise<{ output: string; exitCode: number }> {
	const proc = spawn({
		cmd: [agentConfig.command, ...agentConfig.args],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	// Write prompt to stdin
	proc.stdin.write(prompt);
	proc.stdin.end();

	// Collect output
	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	return { output, exitCode };
}

/**
 * Handle Ctrl+C - save state and exit gracefully
 */
async function handleShutdown(): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;

	console.log("\n\nInterrupted! Saving state...");

	if (currentPrdName && currentStory) {
		// Update lastRun in PRD
		await updateLastRun(currentPrdName, {
			timestamp: new Date().toISOString(),
			storyId: currentStory.id,
			reason: "user_interrupted",
			summary: `Interrupted while working on ${currentStory.id}: ${currentStory.title}`,
		});

		console.log(`Saved state: stopped at ${currentStory.id}`);
	}

	process.exit(0);
}

/**
 * Runs the orchestration loop for a PRD.
 */
export async function runOrchestration(prdName: string): Promise<void> {
	const config = await loadRalphConfig();

	const agentName = config.default_agent;
	const maxIterations = config.default_iterations;

	// Validate agent exists
	const agentConfig = config.agents[agentName];
	if (!agentConfig) {
		throw new Error(
			`Agent '${agentName}' not found in config. Available: ${Object.keys(config.agents).join(", ")}`,
		);
	}

	// Set up Ctrl+C handler
	currentPrdName = prdName;
	process.on("SIGINT", handleShutdown);
	process.on("SIGTERM", handleShutdown);

	console.log(`Starting orchestration for PRD: ${prdName}`);
	console.log(`Using agent: ${agentName}`);
	console.log(`Max iterations: ${maxIterations}`);
	console.log(`Press Ctrl+C to stop\n`);

	// Check for blocked stories first
	const blocked = await hasBlockedStories(prdName);
	if (blocked.length > 0) {
		console.log("⚠️  Blocked stories found:\n");
		for (const story of blocked) {
			console.log(`  ${story.id}: ${story.title}`);
			if (story.questions.length > 0) {
				console.log("  Questions:");
				for (const q of story.questions) {
					console.log(`    - ${q}`);
				}
			}
			console.log();
		}
		console.log("Please resolve these before continuing.");
		return;
	}

	for (let i = 0; i < maxIterations; i++) {
		if (isShuttingDown) break;

		console.log(`\n=== Iteration ${i + 1}/${maxIterations} ===`);

		// Get current PRD and next story
		const prd = await getPRD(prdName);
		const story = await getNextStory(prdName);

		if (!story) {
			console.log("All stories complete!");

			if (config.auto_archive) {
				console.log("Auto-archiving PRD...");
				await archivePRD(prdName);
			}

			// Update lastRun
			await updateLastRun(prdName, {
				timestamp: new Date().toISOString(),
				storyId: "ALL",
				reason: "completed",
				summary: "All stories completed successfully",
			});

			return;
		}

		// Update current story for Ctrl+C handler
		currentStory = story;

		// Mark story as in_progress
		await updateStoryStatus(prdName, story.id, "in_progress");

		console.log(`Working on: ${story.id} - ${story.title}`);

		// Generate prompt
		const prompt = await generatePrompt(prd, story, prdName);

		// Run agent
		console.log("Spawning agent...");
		const { output, exitCode } = await runAgent(prompt, agentConfig);

		// Log output
		console.log("\n--- Agent Output ---");
		console.log(output);
		console.log(`--- Exit Code: ${exitCode} ---\n`);

		// Check for completion signal
		if (output.includes("<promise>COMPLETE</promise>")) {
			console.log("Agent signaled completion!");

			// Check if ALL stories are actually completed before archiving
			const allComplete = await isPRDComplete(prdName);

			if (allComplete) {
				// Update lastRun BEFORE archiving (archiving moves the PRD)
				await updateLastRun(prdName, {
					timestamp: new Date().toISOString(),
					storyId: "ALL",
					reason: "completed",
					summary: "All stories completed successfully",
				});

				if (config.auto_archive) {
					console.log("Auto-archiving PRD...");
					await archivePRD(prdName);
				}
			} else {
				// Agent signaled completion but there are still pending stories
				await updateLastRun(prdName, {
					timestamp: new Date().toISOString(),
					storyId: story.id,
					reason: "story_completed",
					summary: `Story ${story.id} completed, more stories pending`,
				});
			}

			return;
		}

		// Check if story was marked as completed or blocked
		const updatedPrd = await getPRD(prdName);
		const updatedStory = updatedPrd.stories.find((s) => s.id === story.id);

		if (updatedStory?.status === "completed") {
			console.log(`Story ${story.id} completed`);
		} else if (updatedStory?.status === "blocked") {
			console.log(`Story ${story.id} is blocked`);
			if (updatedStory.questions.length > 0) {
				console.log("Questions:");
				for (const q of updatedStory.questions) {
					console.log(`  - ${q}`);
				}
			}

			await updateLastRun(prdName, {
				timestamp: new Date().toISOString(),
				storyId: story.id,
				reason: "blocked",
				summary: `Blocked on ${story.id}: ${updatedStory.questions.join("; ")}`,
			});

			return;
		} else {
			console.log(`Story ${story.id} still in progress`);
		}
	}

	console.log(`\nReached max iterations (${maxIterations})`);
	console.log("Run 'omnidev ralph start' again to continue.");

	await updateLastRun(prdName, {
		timestamp: new Date().toISOString(),
		storyId: currentStory?.id ?? "unknown",
		reason: "user_interrupted",
		summary: `Reached max iterations while working on ${currentStory?.id}`,
	});
}
