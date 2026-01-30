/**
 * Ralph Event-Based API
 *
 * Provides EventEmitter-based wrappers for orchestration and testing
 * that emit events instead of writing to stdout. Designed for daemon integration.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { loadRalphConfig, type RunAgentOptions } from "./orchestrator.js";
import {
	extractAndSaveFindings,
	findPRDLocation,
	getNextStory,
	getPRD,
	hasBlockedStories,
	isPRDComplete,
	markPRDCompleted,
	markPRDStarted,
	movePRD,
	savePRD,
	updateLastRun,
	updateMetrics,
	updateStoryStatus,
	addFixStory,
	clearTestResults,
} from "./state.js";
import {
	detectTestResult,
	extractIssues,
	generateTestPrompt,
	parseTestReport,
	saveTestReport,
} from "./testing.js";
import { generatePrompt } from "./prompt.js";
import {
	generateSimpleVerification,
	generateVerification,
	hasVerification,
} from "./verification.js";
import type { AgentConfig, Story, TestReport } from "./types.js";

/**
 * Event types emitted by the orchestrator
 */
export type OrchestratorEvent =
	| { type: "log"; level: "info" | "warn" | "error"; message: string }
	| { type: "state_change"; prdName: string; from: string; to: string }
	| { type: "story_update"; prdName: string; storyId: string; status: string }
	| { type: "iteration"; prdName: string; current: number; max: number; storyId: string }
	| { type: "agent_output"; data: string }
	| { type: "agent_exit"; code: number }
	| { type: "health_check_start"; timeout: number }
	| { type: "health_check_progress"; elapsed: number; timeout: number }
	| { type: "health_check_passed" }
	| { type: "health_check_failed"; error: string }
	| {
			type: "complete";
			result: "success" | "blocked" | "max_iterations" | "error";
			message: string;
	  }
	| { type: "test_complete"; result: "verified" | "failed" | "unknown"; issues?: string[] }
	| { type: "error"; error: string };

/**
 * Options for running orchestration
 */
export interface OrchestratorOptions {
	/** Override the default agent */
	agent?: string;
	/** Working directory (defaults to cwd) */
	cwd?: string;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
}

/**
 * Orchestrator class that emits events
 */
export class Orchestrator extends EventEmitter {
	private isRunning = false;
	private currentPrdName: string | null = null;
	private currentStory: Story | null = null;
	private abortController: AbortController | null = null;

	constructor() {
		super();
	}

	/**
	 * Emit a typed event
	 */
	private emitEvent(event: OrchestratorEvent): void {
		this.emit("event", event);
		this.emit(event.type, event);
	}

	/**
	 * Log helper
	 */
	private log(level: "info" | "warn" | "error", message: string): void {
		this.emitEvent({ type: "log", level, message });
	}

	/**
	 * Run agent and stream output via events
	 */
	private async runAgentWithEvents(
		prompt: string,
		agentConfig: AgentConfig,
		options?: RunAgentOptions & { signal?: AbortSignal },
	): Promise<{ output: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			const proc = spawn(agentConfig.command, agentConfig.args, {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let plainText = "";

			// Handle abort signal
			if (options?.signal) {
				options.signal.addEventListener("abort", () => {
					proc.kill("SIGTERM");
				});
			}

			proc.stdout?.on("data", (data) => {
				const chunk = data.toString();
				stdout += chunk;

				// Try to parse as stream-json
				const lines = chunk.split("\n");
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "assistant" && event.message?.content) {
							for (const block of event.message.content) {
								if (block.type === "text" && block.text) {
									plainText += block.text;
									this.emitEvent({ type: "agent_output", data: block.text });
								}
							}
						}
					} catch {
						// Not JSON, emit as raw output
						plainText += line + "\n";
						this.emitEvent({ type: "agent_output", data: line + "\n" });
					}
				}
			});

			proc.stderr?.on("data", (data) => {
				const chunk = data.toString();
				stderr += chunk;
				this.emitEvent({ type: "agent_output", data: chunk });
			});

			proc.on("error", (error) => {
				reject(error);
			});

			proc.on("close", (code) => {
				const exitCode = code ?? 1;
				this.emitEvent({ type: "agent_exit", code: exitCode });
				resolve({ output: plainText || stdout + stderr, exitCode });
			});

			// Write prompt to stdin
			if (proc.stdin) {
				proc.stdin.write(prompt);
				proc.stdin.end();
			}
		});
	}

	/**
	 * Run development orchestration for a PRD
	 */
	async runOrchestration(prdName: string, options: OrchestratorOptions = {}): Promise<void> {
		if (this.isRunning) {
			throw new Error("Orchestrator is already running");
		}

		this.isRunning = true;
		this.currentPrdName = prdName;
		this.abortController = new AbortController();

		const signal = options.signal || this.abortController.signal;

		try {
			const config = await loadRalphConfig();
			const agentName = options.agent ?? config.default_agent;
			const maxIterations = config.default_iterations;

			const agentConfig = config.agents[agentName];
			if (!agentConfig) {
				throw new Error(
					`Agent '${agentName}' not found. Available: ${Object.keys(config.agents).join(", ")}`,
				);
			}

			this.log("info", `Starting orchestration for PRD: ${prdName}`);
			this.log("info", `Using agent: ${agentName}, max iterations: ${maxIterations}`);

			// Mark PRD as started
			await markPRDStarted(prdName);

			// Check for blocked stories
			const blocked = await hasBlockedStories(prdName);
			if (blocked.length > 0) {
				this.log("warn", `${blocked.length} blocked stories found`);
				this.emitEvent({
					type: "complete",
					result: "blocked",
					message: `Blocked stories: ${blocked.map((s) => s.id).join(", ")}`,
				});
				return;
			}

			for (let i = 0; i < maxIterations; i++) {
				if (signal.aborted) {
					this.log("info", "Orchestration aborted");
					break;
				}

				const prd = await getPRD(prdName);
				const story = await getNextStory(prdName);

				if (!story) {
					this.log("info", "All stories complete!");

					await markPRDCompleted(prdName);
					await extractAndSaveFindings(prdName);

					const oldStatus = findPRDLocation(prdName) || "pending";
					await movePRD(prdName, "testing");
					this.emitEvent({ type: "state_change", prdName, from: oldStatus, to: "testing" });

					// Generate verification
					try {
						await generateVerification(prdName, agentConfig, (p: string, a: AgentConfig) =>
							this.runAgentWithEvents(p, a, { signal }),
						);
					} catch {
						await generateSimpleVerification(prdName);
					}

					await updateLastRun(prdName, {
						timestamp: new Date().toISOString(),
						storyId: "ALL",
						reason: "completed",
						summary: "All stories completed. PRD moved to testing.",
					});

					this.emitEvent({
						type: "complete",
						result: "success",
						message: "PRD moved to testing",
					});
					return;
				}

				this.currentStory = story;
				const iterationCount = (story.iterationCount ?? 0) + 1;

				this.emitEvent({
					type: "iteration",
					prdName,
					current: i + 1,
					max: maxIterations,
					storyId: story.id,
				});

				// Check if stuck
				if (iterationCount > 3 && story.status === "in_progress") {
					this.log(
						"warn",
						`Story ${story.id} stuck for ${iterationCount} iterations, auto-blocking`,
					);
					await updateStoryStatus(prdName, story.id, "blocked", [
						`Auto-blocked after ${iterationCount} failed iterations`,
					]);
					this.emitEvent({ type: "story_update", prdName, storyId: story.id, status: "blocked" });
					this.emitEvent({
						type: "complete",
						result: "blocked",
						message: `Story ${story.id} auto-blocked`,
					});
					return;
				}

				// Mark in progress
				await updateStoryStatus(prdName, story.id, "in_progress");
				this.emitEvent({ type: "story_update", prdName, storyId: story.id, status: "in_progress" });

				// Update iteration count
				const prdForUpdate = await getPRD(prdName);
				const storyToUpdate = prdForUpdate.stories.find((s) => s.id === story.id);
				if (storyToUpdate) {
					storyToUpdate.iterationCount = iterationCount;
					await savePRD(prdName, prdForUpdate);
				}

				this.log("info", `Working on: ${story.id} - ${story.title} (iteration ${iterationCount})`);

				// Generate and run
				const prompt = await generatePrompt(prd, story, prdName);
				const { output, exitCode } = await this.runAgentWithEvents(prompt, agentConfig, { signal });

				this.log("info", `Agent exit code: ${exitCode}`);
				await updateMetrics(prdName, { iterations: 1 });

				// Check completion signal
				if (output.includes("<promise>COMPLETE</promise>")) {
					this.log("info", "Agent signaled completion");

					const allComplete = await isPRDComplete(prdName);
					if (allComplete) {
						await markPRDCompleted(prdName);
						await extractAndSaveFindings(prdName);

						const oldStatus = findPRDLocation(prdName) || "pending";
						await movePRD(prdName, "testing");
						this.emitEvent({ type: "state_change", prdName, from: oldStatus, to: "testing" });

						try {
							await generateVerification(prdName, agentConfig, (p: string, a: AgentConfig) =>
								this.runAgentWithEvents(p, a, { signal }),
							);
						} catch {
							await generateSimpleVerification(prdName);
						}

						this.emitEvent({
							type: "complete",
							result: "success",
							message: "PRD moved to testing",
						});
						return;
					}
				}

				// Check story status
				const updatedPrd = await getPRD(prdName);
				const updatedStory = updatedPrd.stories.find((s) => s.id === story.id);

				if (updatedStory?.status === "completed") {
					this.log("info", `Story ${story.id} completed`);
					this.emitEvent({ type: "story_update", prdName, storyId: story.id, status: "completed" });
				} else if (updatedStory?.status === "blocked") {
					this.log("warn", `Story ${story.id} blocked`);
					this.emitEvent({ type: "story_update", prdName, storyId: story.id, status: "blocked" });
					this.emitEvent({
						type: "complete",
						result: "blocked",
						message: `Story ${story.id} blocked`,
					});
					return;
				}
			}

			this.log("info", `Reached max iterations (${maxIterations})`);
			this.emitEvent({
				type: "complete",
				result: "max_iterations",
				message: `Reached max iterations (${maxIterations})`,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitEvent({ type: "error", error: message });
			throw error;
		} finally {
			this.isRunning = false;
			this.currentPrdName = null;
			this.currentStory = null;
			this.abortController = null;
		}
	}

	/**
	 * Run testing for a PRD
	 */
	async runTesting(
		prdName: string,
		options: OrchestratorOptions = {},
	): Promise<{ report: TestReport; result: "verified" | "failed" | "unknown" }> {
		if (this.isRunning) {
			throw new Error("Orchestrator is already running");
		}

		this.isRunning = true;
		this.currentPrdName = prdName;
		this.abortController = new AbortController();

		const signal = options.signal || this.abortController.signal;

		try {
			const config = await loadRalphConfig();
			const agentName = options.agent ?? config.default_agent;

			const agentConfig = config.agents[agentName];
			if (!agentConfig) {
				throw new Error(
					`Agent '${agentName}' not found. Available: ${Object.keys(config.agents).join(", ")}`,
				);
			}

			const status = findPRDLocation(prdName);
			if (!status) {
				throw new Error(`PRD not found: ${prdName}`);
			}

			if (status !== "testing") {
				this.log("warn", `PRD "${prdName}" is in ${status} status (not testing)`);
			}

			// Ensure verification exists
			if (!hasVerification(prdName)) {
				this.log("info", "Generating verification checklist...");
				try {
					await generateVerification(prdName, agentConfig, (p: string, a: AgentConfig) =>
						this.runAgentWithEvents(p, a, { signal }),
					);
				} catch {
					await generateSimpleVerification(prdName);
				}
			}

			// Clear previous results
			await clearTestResults(prdName);

			this.log("info", `Starting testing for PRD: ${prdName}`);

			// Run scripts
			const scripts = config.scripts;

			// Teardown first
			this.log("info", "Running teardown...");
			await this.runScript(scripts?.teardown, "teardown", prdName);

			// Setup
			this.log("info", "Running setup...");
			await this.runScript(scripts?.setup, "setup", prdName);

			// Start
			this.log("info", "Running start...");
			await this.runScript(scripts?.start, "start", prdName);

			// Health check
			const timeout = config.testing?.health_check_timeout ?? 120;
			const healthPassed = await this.waitForHealthCheck(scripts?.health_check, timeout, signal);

			if (!healthPassed) {
				this.emitEvent({
					type: "health_check_failed",
					error: `Health check timed out after ${timeout}s`,
				});
				// Don't fail completely, let the test agent run
				this.log("warn", "Health check failed, continuing anyway");
			}

			// Generate prompt and run
			const prompt = await generateTestPrompt(prdName, config);

			this.log("info", "Spawning test agent...");
			const { output, exitCode } = await this.runAgentWithEvents(prompt, agentConfig, { signal });

			this.log("info", `Agent exit code: ${exitCode}`);

			// Parse results
			const report = parseTestReport(output, prdName);
			const testResult = detectTestResult(output);
			const issues = extractIssues(output);

			await saveTestReport(prdName, report);

			// Teardown
			this.log("info", "Running teardown...");
			await this.runScript(scripts?.teardown, "teardown", prdName);

			// Handle result
			if (testResult === "verified") {
				this.log("info", "PRD_VERIFIED - moving to completed");
				await extractAndSaveFindings(prdName);

				const oldStatus = findPRDLocation(prdName) || "testing";
				await movePRD(prdName, "completed");
				this.emitEvent({ type: "state_change", prdName, from: oldStatus, to: "completed" });
				this.emitEvent({ type: "test_complete", result: "verified" });

				return { report, result: "verified" };
			}

			if (testResult === "failed") {
				this.log("warn", `PRD_FAILED - ${issues.length} issues found`);

				const testResultsRelPath = "test-results/report.md";
				await addFixStory(prdName, issues, testResultsRelPath);

				const oldStatus = findPRDLocation(prdName) || "testing";
				await movePRD(prdName, "pending");
				this.emitEvent({ type: "state_change", prdName, from: oldStatus, to: "pending" });
				this.emitEvent({ type: "test_complete", result: "failed", issues });

				return { report, result: "failed" };
			}

			this.log("warn", "No clear test result signal detected");
			this.emitEvent({ type: "test_complete", result: "unknown" });

			return { report, result: "unknown" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitEvent({ type: "error", error: message });
			throw error;
		} finally {
			this.isRunning = false;
			this.currentPrdName = null;
			this.abortController = null;
		}
	}

	/**
	 * Stop the current operation
	 */
	stop(): void {
		if (this.abortController) {
			this.abortController.abort();
		}
	}

	/**
	 * Check if running
	 */
	getIsRunning(): boolean {
		return this.isRunning;
	}

	/**
	 * Run a script
	 */
	private async runScript(
		scriptPath: string | undefined,
		name: string,
		prdName?: string,
	): Promise<{ success: boolean; output: string }> {
		if (!scriptPath) {
			return { success: true, output: `${name} not configured` };
		}

		const { existsSync } = await import("node:fs");
		const { join } = await import("node:path");
		const fullPath = join(process.cwd(), scriptPath);

		if (!existsSync(fullPath)) {
			return { success: true, output: `${name} not found` };
		}

		return new Promise((resolve) => {
			const args = prdName ? [fullPath, prdName] : [fullPath];
			const proc = spawn("bash", args, { stdio: ["pipe", "pipe", "pipe"] });

			let output = "";
			proc.stdout?.on("data", (d) => {
				output += d.toString();
			});
			proc.stderr?.on("data", (d) => {
				output += d.toString();
			});

			proc.on("close", (code) => {
				resolve({ success: code === 0, output });
			});
			proc.on("error", (err) => {
				resolve({ success: false, output: err.message });
			});
		});
	}

	/**
	 * Wait for health check with events
	 */
	private async waitForHealthCheck(
		scriptPath: string | undefined,
		timeout: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!scriptPath) {
			return true;
		}

		this.emitEvent({ type: "health_check_start", timeout });

		const startTime = Date.now();
		const timeoutMs = timeout * 1000;

		while (Date.now() - startTime < timeoutMs) {
			if (signal?.aborted) {
				return false;
			}

			const { success } = await this.runScript(scriptPath, "health_check");
			if (success) {
				this.emitEvent({ type: "health_check_passed" });
				return true;
			}

			const elapsed = Math.round((Date.now() - startTime) / 1000);
			this.emitEvent({ type: "health_check_progress", elapsed, timeout });

			await new Promise((resolve) => setTimeout(resolve, 2000));
		}

		return false;
	}
}

/**
 * Create a new orchestrator instance
 */
export function createOrchestrator(): Orchestrator {
	return new Orchestrator();
}
