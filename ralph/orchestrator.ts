/**
 * Ralph Orchestrator
 *
 * Handles agent spawning and iteration loops for PRD-driven development.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { generatePrompt } from "./prompt.ts";
import {
	extractAndSaveFindings,
	getNextStory,
	getPRD,
	hasBlockedStories,
	isPRDComplete,
	markPRDCompleted,
	markPRDStarted,
	movePRD,
	updateLastRun,
	updateMetrics,
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

	const content = await readFile(CONFIG_PATH, "utf-8");

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
	return new Promise((resolve, reject) => {
		const proc = spawn(agentConfig.command, agentConfig.args, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("error", (error) => {
			reject(error);
		});

		proc.on("close", (code) => {
			resolve({ output: stdout + stderr, exitCode: code ?? 1 });
		});

		// Write prompt to stdin
		if (proc.stdin) {
			proc.stdin.write(prompt);
			proc.stdin.end();
		}
	});
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

	// Mark PRD as started (records timestamp on first run)
	await markPRDStarted(prdName);

	// Check for blocked stories first
	const blocked = await hasBlockedStories(prdName);
	if (blocked.length > 0) {
		console.log("🚫 Blocked stories found:\n");
		for (const story of blocked) {
			console.log(`  ${story.id}: ${story.title}`);
			if (story.questions.length > 0) {
				console.log("  Questions:");
				for (let i = 0; i < story.questions.length; i++) {
					const q = story.questions[i];
					const ans = story.answers?.[i];
					if (ans) {
						console.log(`    ${i + 1}. ${q}`);
						console.log(`       Answer: ${ans}`);
					} else {
						console.log(`    ${i + 1}. ${q}`);
					}
				}
			}
			console.log();
		}
		console.log("Please resolve these before continuing.");
		console.log(`Use 'omnidev ralph start ${prdName}' to be prompted to answer questions.`);
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

			// Mark PRD as completed
			await markPRDCompleted(prdName);

			// Extract findings and move to testing
			console.log("Extracting findings...");
			await extractAndSaveFindings(prdName);

			console.log("Moving PRD to testing...");
			await movePRD(prdName, "testing");

			// Update lastRun
			await updateLastRun(prdName, {
				timestamp: new Date().toISOString(),
				storyId: "ALL",
				reason: "completed",
				summary: "All stories completed. PRD moved to testing for verification.",
			});

			console.log("\nPRD moved to testing. Run manual verification, then:");
			console.log(`  omnidev ralph prd ${prdName} --move completed  # if verified`);
			console.log(`  omnidev ralph prd ${prdName} --move pending    # if issues found`);

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

		// Track iteration
		await updateMetrics(prdName, { iterations: 1 });

		// Try to parse token usage from Claude Code output
		const inputMatch = output.match(/Input:\s*([\d,]+)/i);
		const outputMatch = output.match(/Output:\s*([\d,]+)/i);
		if (inputMatch?.[1] || outputMatch?.[1]) {
			await updateMetrics(prdName, {
				inputTokens: inputMatch?.[1] ? Number.parseInt(inputMatch[1].replace(/,/g, ""), 10) : 0,
				outputTokens: outputMatch?.[1] ? Number.parseInt(outputMatch[1].replace(/,/g, ""), 10) : 0,
			});
		}

		// Check for completion signal
		if (output.includes("<promise>COMPLETE</promise>")) {
			console.log("Agent signaled completion!");

			// Check if ALL stories are actually completed
			const allComplete = await isPRDComplete(prdName);

			if (allComplete) {
				// Mark PRD as completed
				await markPRDCompleted(prdName);

				// Extract findings and move to testing
				console.log("Extracting findings...");
				await extractAndSaveFindings(prdName);

				console.log("Moving PRD to testing...");
				await movePRD(prdName, "testing");

				await updateLastRun(prdName, {
					timestamp: new Date().toISOString(),
					storyId: "ALL",
					reason: "completed",
					summary: "All stories completed. PRD moved to testing for verification.",
				});

				console.log("\nPRD moved to testing. Run manual verification, then:");
				console.log(`  omnidev ralph prd ${prdName} --move completed  # if verified`);
				console.log(`  omnidev ralph prd ${prdName} --move pending    # if issues found`);
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
			console.log(`\n🚫 Story ${story.id} is blocked`);
			if (updatedStory.questions.length > 0) {
				console.log("\nQuestions to resolve:");
				for (let i = 0; i < updatedStory.questions.length; i++) {
					console.log(`  ${i + 1}. ${updatedStory.questions[i]}`);
				}
				console.log(
					`\nRun 'omnidev ralph start ${prdName}' again to be prompted to answer these questions.`,
				);
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
