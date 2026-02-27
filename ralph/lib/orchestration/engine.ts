/**
 * Ralph Orchestration Engine
 *
 * Unified orchestration implementation used by both CLI and daemon.
 * Consolidates logic from orchestrator.ts and events.ts.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { PRD, AgentConfig, TestReport, RalphConfig } from "../types.js";
import type { Result } from "../results.js";
import { ok, err, ErrorCodes } from "../results.js";
import { type PRDStore, getDefaultStore } from "../core/prd-store.js";
import {
	loadConfig,
	getAgentConfig,
	getScriptsConfig,
	getTestingConfig,
	getReviewConfig,
	resolveReviewAgents,
} from "../core/config.js";
import { type Logger, getLogger } from "../core/logger.js";
import { type AgentExecutor, getAgentExecutor } from "./agent-runner.js";
import { generatePrompt } from "../prompt.js";
import {
	generateTestPrompt,
	generateRetestPrompt,
	getPreviousFailures,
	detectTestResult,
	detectHealthCheckResult,
	extractIssues,
	parseTestReport,
	saveTestReport,
} from "../testing.js";
import {
	generateVerification,
	generateSimpleVerification,
	hasVerification,
} from "../verification.js";
import { extractAndSaveFindings } from "../state.js";
import { ReviewEngine } from "./review-engine.js";

/**
 * Engine context - dependencies injected into the engine
 */
export interface EngineContext {
	projectName: string;
	repoRoot: string;
	store: PRDStore;
	agentExecutor: AgentExecutor;
	logger: Logger;
	signal?: AbortSignal;
}

/**
 * Event types emitted during orchestration
 */
export type EngineEvent =
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
	| { type: "error"; error: string }
	| { type: "review_start"; phase: "first" | "external" | "second" | "finalize" }
	| { type: "review_agent_complete"; reviewType: string; decision: string; findingsCount: number }
	| { type: "review_fix_start"; iteration: number; findingsCount: number }
	| { type: "review_phase_complete"; phase: string; clean: boolean };

/**
 * Options for running orchestration
 */
export interface RunOptions {
	/** Override the default agent */
	agent?: string;
	/** Callback for events */
	onEvent?: (event: EngineEvent) => void;
	/** Abort signal */
	signal?: AbortSignal;
}

/**
 * Result of development run
 */
export interface DevelopmentResult {
	prdName: string;
	outcome: "moved_to_testing" | "blocked" | "max_iterations" | "aborted";
	message: string;
	storiesCompleted: number;
	storiesRemaining: number;
	reviewPerformed?: boolean;
	reviewFindingsFixed?: number;
}

/**
 * Result of test run
 */
export interface TestRunResult {
	prdName: string;
	outcome: "verified" | "failed" | "unknown" | "health_check_failed";
	report: TestReport;
	issues?: string[];
}

/**
 * Orchestration Engine - core orchestration logic
 */
export class OrchestrationEngine {
	private ctx: EngineContext;

	constructor(
		ctx: Pick<EngineContext, "projectName" | "repoRoot"> &
			Partial<Omit<EngineContext, "projectName" | "repoRoot">>,
	) {
		this.ctx = {
			projectName: ctx.projectName,
			repoRoot: ctx.repoRoot,
			store: ctx.store ?? getDefaultStore(ctx.projectName, ctx.repoRoot),
			agentExecutor: ctx.agentExecutor ?? getAgentExecutor(),
			logger: ctx.logger ?? getLogger(),
			signal: ctx.signal,
		};
	}

	/**
	 * Run development orchestration for a PRD
	 */
	async runDevelopment(
		prdName: string,
		options: RunOptions = {},
	): Promise<Result<DevelopmentResult>> {
		const signal = options.signal ?? this.ctx.signal;
		const emit = options.onEvent ?? (() => {});
		const log = (level: "info" | "warn" | "error", message: string) => {
			this.ctx.logger.log(level, message, { prdName });
			emit({ type: "log", level, message });
		};

		// Load config
		const configResult = await loadConfig();
		if (!configResult.ok) {
			return err(configResult.error!.code, configResult.error!.message);
		}
		const config = configResult.data!;

		// Get agent config
		const agentConfigResult = getAgentConfig(config, options.agent);
		if (!agentConfigResult.ok) {
			return err(agentConfigResult.error!.code, agentConfigResult.error!.message);
		}
		const agentConfig = agentConfigResult.data!;
		const maxIterations = config.default_iterations;

		log("info", `Starting orchestration for PRD: ${prdName}`);
		log(
			"info",
			`Using agent: ${options.agent ?? config.default_agent}, max iterations: ${maxIterations}`,
		);

		// Mark PRD as started
		await this.ctx.store.markStarted(prdName);

		// Check for blocked stories
		const blockedResult = await this.ctx.store.getBlockedStories(prdName);
		if (!blockedResult.ok) {
			return err(blockedResult.error!.code, blockedResult.error!.message);
		}
		const blockedStories = blockedResult.data!;

		if (blockedStories.length > 0) {
			log("warn", `${blockedStories.length} blocked stories found`);
			emit({
				type: "complete",
				result: "blocked",
				message: `Blocked stories: ${blockedStories.map((s) => s.id).join(", ")}`,
			});
			return ok({
				prdName,
				outcome: "blocked",
				message: `Blocked stories: ${blockedStories.map((s) => s.id).join(", ")}`,
				storiesCompleted: 0,
				storiesRemaining: blockedStories.length,
			});
		}

		// Main iteration loop
		for (let i = 0; i < maxIterations; i++) {
			if (signal?.aborted) {
				log("info", "Orchestration aborted");
				return ok({
					prdName,
					outcome: "aborted",
					message: "Orchestration aborted",
					storiesCompleted: 0,
					storiesRemaining: 0,
				});
			}

			// Get PRD and next story
			const prdResult = await this.ctx.store.get(prdName);
			if (!prdResult.ok) {
				return err(prdResult.error!.code, prdResult.error!.message);
			}
			const prd = prdResult.data!;

			const storyResult = await this.ctx.store.getNextStory(prdName);
			if (!storyResult.ok) {
				return err(storyResult.error!.code, storyResult.error!.message);
			}
			const story = storyResult.data;

			if (!story) {
				// All stories complete
				log("info", "All stories complete!");
				await this.handleDevelopmentComplete(prdName, prd, agentConfig, emit, signal);

				const completedCount = prd.stories.filter((s) => s.status === "completed").length;
				return ok({
					prdName,
					outcome: "moved_to_testing",
					message: "PRD moved to testing",
					storiesCompleted: completedCount,
					storiesRemaining: 0,
				});
			}

			const iterationCount = (story.iterationCount ?? 0) + 1;

			emit({
				type: "iteration",
				prdName,
				current: i + 1,
				max: maxIterations,
				storyId: story.id,
			});

			// Check if stuck
			if (iterationCount > 3 && story.status === "in_progress") {
				log("warn", `Story ${story.id} stuck for ${iterationCount} iterations, auto-blocking`);
				await this.ctx.store.updateStoryStatus(prdName, story.id, "blocked", [
					`Auto-blocked after ${iterationCount} failed iterations`,
				]);
				emit({ type: "story_update", prdName, storyId: story.id, status: "blocked" });
				emit({
					type: "complete",
					result: "blocked",
					message: `Story ${story.id} auto-blocked`,
				});

				const finalPrd = (await this.ctx.store.get(prdName)).data!;
				return ok({
					prdName,
					outcome: "blocked",
					message: `Story ${story.id} auto-blocked after ${iterationCount} failed iterations`,
					storiesCompleted: finalPrd.stories.filter((s) => s.status === "completed").length,
					storiesRemaining: finalPrd.stories.filter((s) => s.status !== "completed").length,
				});
			}

			// Mark in progress and update iteration count
			await this.ctx.store.update(prdName, (p) => {
				const s = p.stories.find((st) => st.id === story.id);
				if (s) {
					s.status = "in_progress";
					s.iterationCount = iterationCount;
				}
				return p;
			});
			emit({ type: "story_update", prdName, storyId: story.id, status: "in_progress" });

			log("info", `Working on: ${story.id} - ${story.title} (iteration ${iterationCount})`);

			// Generate and run
			const prompt = await generatePrompt(
				this.ctx.projectName,
				this.ctx.repoRoot,
				prd,
				story,
				prdName,
			);
			const result = await this.ctx.agentExecutor.run(prompt, agentConfig, {
				stream: true,
				signal,
				onOutput: (data) => emit({ type: "agent_output", data }),
			});

			emit({ type: "agent_exit", code: result.exitCode });
			log("info", `Agent exit code: ${result.exitCode}`);

			await this.ctx.store.updateMetrics(prdName, { iterations: 1 });

			// Parse token usage
			const tokenUsage = this.ctx.agentExecutor.parseTokenUsage(result.output);
			if (tokenUsage.inputTokens || tokenUsage.outputTokens) {
				await this.ctx.store.updateMetrics(prdName, tokenUsage);
			}

			// Check completion signal
			if (this.ctx.agentExecutor.hasCompletionSignal(result.output)) {
				log("info", "Agent signaled completion");

				const isCompleteResult = await this.ctx.store.isComplete(prdName);
				if (isCompleteResult.ok && isCompleteResult.data) {
					await this.handleDevelopmentComplete(prdName, prd, agentConfig, emit, signal);

					return ok({
						prdName,
						outcome: "moved_to_testing",
						message: "PRD moved to testing",
						storiesCompleted: prd.stories.length,
						storiesRemaining: 0,
					});
				}
			}

			// Check story status after agent run
			const updatedPrd = (await this.ctx.store.get(prdName)).data!;
			const updatedStory = updatedPrd.stories.find((s) => s.id === story.id);

			if (updatedStory?.status === "completed") {
				log("info", `Story ${story.id} completed`);
				emit({ type: "story_update", prdName, storyId: story.id, status: "completed" });
			} else if (updatedStory?.status === "blocked") {
				log("warn", `Story ${story.id} blocked`);
				emit({ type: "story_update", prdName, storyId: story.id, status: "blocked" });
				emit({
					type: "complete",
					result: "blocked",
					message: `Story ${story.id} blocked`,
				});

				return ok({
					prdName,
					outcome: "blocked",
					message: `Story ${story.id} blocked`,
					storiesCompleted: updatedPrd.stories.filter((s) => s.status === "completed").length,
					storiesRemaining: updatedPrd.stories.filter((s) => s.status !== "completed").length,
				});
			} else {
				// Try to infer status from output
				const inferredStatus = this.ctx.agentExecutor.parseStatus(result.output, story.id);
				if (inferredStatus === "completed") {
					log("info", `Inferred story ${story.id} completed from output`);
					await this.ctx.store.updateStoryStatus(prdName, story.id, "completed");
					emit({ type: "story_update", prdName, storyId: story.id, status: "completed" });
				} else if (inferredStatus === "blocked") {
					log("info", `Inferred story ${story.id} blocked from output`);
					await this.ctx.store.updateStoryStatus(prdName, story.id, "blocked", [
						"Agent indicated this story is blocked. Please review the output for details.",
					]);
					emit({ type: "story_update", prdName, storyId: story.id, status: "blocked" });
				}
			}
		}

		// Max iterations reached
		log("info", `Reached max iterations (${maxIterations})`);
		emit({
			type: "complete",
			result: "max_iterations",
			message: `Reached max iterations (${maxIterations})`,
		});

		const finalPrd = (await this.ctx.store.get(prdName)).data!;
		return ok({
			prdName,
			outcome: "max_iterations",
			message: `Reached max iterations (${maxIterations})`,
			storiesCompleted: finalPrd.stories.filter((s) => s.status === "completed").length,
			storiesRemaining: finalPrd.stories.filter((s) => s.status !== "completed").length,
		});
	}

	/**
	 * Handle development completion - extract findings, run review, generate verification, move to testing
	 */
	private async handleDevelopmentComplete(
		prdName: string,
		_prd: PRD,
		agentConfig: AgentConfig,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		await this.ctx.store.markCompleted(prdName);
		await extractAndSaveFindings(this.ctx.projectName, this.ctx.repoRoot, prdName);

		// Run code review pipeline
		const configResult = await loadConfig();
		if (configResult.ok) {
			const reviewConfig = getReviewConfig(configResult.data!);
			if (reviewConfig.enabled) {
				const agentsResult = resolveReviewAgents(configResult.data!, reviewConfig);
				if (!agentsResult.ok) {
					emit({
						type: "log",
						level: "warn",
						message: `Failed to resolve review agents: ${agentsResult.error?.message}`,
					});
				} else {
					const reviewEngine = new ReviewEngine(this.ctx);
					const prdResult = await this.ctx.store.get(prdName);
					const prd = prdResult.ok ? prdResult.data! : _prd;
					const result = await reviewEngine.runReview(
						prdName,
						prd,
						configResult.data!,
						agentsResult.data!,
						reviewConfig,
						emit,
						signal,
					);
					if (!result.ok) {
						emit({
							type: "log",
							level: "warn",
							message: `Review had errors: ${result.error?.message}`,
						});
					}
				}
			}
		}

		const oldStatus = this.ctx.store.findLocation(prdName) ?? "pending";
		await this.ctx.store.transition(prdName, "testing");
		emit({ type: "state_change", prdName, from: oldStatus, to: "testing" });

		// Generate verification — use verification_agent if configured, else fall back to development agentConfig
		let verificationAgentConfig = agentConfig;
		if (configResult.ok && configResult.data!.verification_agent) {
			const vResult = getAgentConfig(configResult.data!, configResult.data!.verification_agent);
			if (vResult.ok) {
				verificationAgentConfig = vResult.data!;
			}
		}
		try {
			const runAgentFn = async (prompt: string, config: AgentConfig) => {
				const result = await this.ctx.agentExecutor.run(prompt, config, { signal });
				return { output: result.output, exitCode: result.exitCode };
			};
			await generateVerification(
				this.ctx.projectName,
				this.ctx.repoRoot,
				prdName,
				verificationAgentConfig,
				runAgentFn,
			);
		} catch {
			await generateSimpleVerification(this.ctx.projectName, this.ctx.repoRoot, prdName);
		}

		await this.ctx.store.updateLastRun(prdName, {
			timestamp: new Date().toISOString(),
			storyId: "ALL",
			reason: "completed",
			summary: "All stories completed. PRD moved to testing.",
		});

		emit({
			type: "complete",
			result: "success",
			message: "PRD moved to testing",
		});
	}

	/**
	 * Run testing for a PRD
	 */
	async runTesting(prdName: string, options: RunOptions = {}): Promise<Result<TestRunResult>> {
		const signal = options.signal ?? this.ctx.signal;
		const emit = options.onEvent ?? (() => {});
		const log = (level: "info" | "warn" | "error", message: string) => {
			this.ctx.logger.log(level, message, { prdName });
			emit({ type: "log", level, message });
		};

		// Load config
		const configResult = await loadConfig();
		if (!configResult.ok) {
			return err(configResult.error!.code, configResult.error!.message);
		}
		const config = configResult.data!;

		// Get agent config
		const agentConfigResult = getAgentConfig(config, options.agent);
		if (!agentConfigResult.ok) {
			return err(agentConfigResult.error!.code, agentConfigResult.error!.message);
		}
		const agentConfig = agentConfigResult.data!;

		const status = this.ctx.store.findLocation(prdName);
		if (!status) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
		}

		if (status !== "testing") {
			log("warn", `PRD "${prdName}" is in ${status} status (not testing)`);
		}

		// Ensure verification exists
		if (!hasVerification(this.ctx.projectName, this.ctx.repoRoot, prdName)) {
			log("info", "Generating verification checklist...");
			try {
				const runAgentFn = async (prompt: string, cfg: AgentConfig) => {
					const result = await this.ctx.agentExecutor.run(prompt, cfg, { signal });
					return { output: result.output, exitCode: result.exitCode };
				};
				await generateVerification(
					this.ctx.projectName,
					this.ctx.repoRoot,
					prdName,
					agentConfig,
					runAgentFn,
				);
			} catch {
				await generateSimpleVerification(this.ctx.projectName, this.ctx.repoRoot, prdName);
			}
		}

		// Check for previous failures (focused retest)
		const previousFailures = await getPreviousFailures(
			this.ctx.projectName,
			this.ctx.repoRoot,
			prdName,
		);
		const isFocusedRetest = previousFailures !== null && previousFailures.length > 0;

		if (isFocusedRetest) {
			log("info", `Found ${previousFailures.length} previous failure(s) - running focused retest`);
		} else {
			// Clear previous results only for full test runs
			this.ctx.store.clearTestResults(prdName);
		}

		log("info", `Starting ${isFocusedRetest ? "focused retest" : "testing"} for PRD: ${prdName}`);

		// Run scripts
		const scripts = getScriptsConfig(config);
		const testingConfig = getTestingConfig(config);
		const healthTimeout = testingConfig.health_check_timeout ?? 30;
		const maxHealthFixAttempts = testingConfig.max_health_fix_attempts ?? 3;

		// Healthcheck fix loop: teardown → setup → start → healthcheck, retry with fix agent on failure
		for (let attempt = 1; attempt <= maxHealthFixAttempts; attempt++) {
			// Teardown first (clean state)
			log(
				"info",
				`${attempt > 1 ? `[Attempt ${attempt}/${maxHealthFixAttempts}] ` : ""}Running teardown...`,
			);
			await this.runScript(scripts.teardown, "teardown", prdName);

			// Setup
			log("info", "Running setup...");
			await this.runScript(scripts.setup, "setup", prdName);

			// Start
			log("info", "Running start...");
			await this.runScript(scripts.start, "start", prdName);

			// Health check
			const healthResult = await this.waitForHealthCheck(
				scripts.health_check,
				healthTimeout,
				emit,
				signal,
			);
			if (healthResult.passed) {
				break;
			}

			// Health check failed
			if (attempt >= maxHealthFixAttempts) {
				emit({
					type: "health_check_failed",
					error: `Health check failed after ${maxHealthFixAttempts} attempt(s)`,
				});
				log(
					"warn",
					`Health check failed after ${maxHealthFixAttempts} attempt(s), continuing anyway`,
				);
				break;
			}

			// Spawn fix agent
			log(
				"info",
				`Health check failed — spawning fix agent (attempt ${attempt}/${maxHealthFixAttempts})`,
			);
			const fixPrompt = this.generateHealthCheckFixPrompt(
				healthResult.logs,
				config,
				attempt,
				maxHealthFixAttempts,
			);
			const fixResult = await this.ctx.agentExecutor.run(fixPrompt, agentConfig, {
				stream: true,
				signal,
				onOutput: (data) => emit({ type: "agent_output", data }),
			});

			const fixSignal = detectHealthCheckResult(fixResult.output);
			if (fixSignal === "fixed") {
				log("info", "Fix agent reports FIXED — retrying lifecycle...");
				continue;
			}

			// NOT_FIXABLE or no signal
			if (fixSignal === "not_fixable") {
				emit({ type: "health_check_failed", error: "Fix agent reports NOT_FIXABLE" });
				log("warn", "Fix agent reports NOT_FIXABLE — continuing anyway");
			} else {
				emit({ type: "health_check_failed", error: "Fix agent did not output a clear signal" });
				log("warn", "Fix agent did not output a clear signal — continuing anyway");
			}
			break;
		}

		// Generate prompt (focused or full)
		const prompt = isFocusedRetest
			? await generateRetestPrompt(
					this.ctx.projectName,
					this.ctx.repoRoot,
					prdName,
					previousFailures,
					config,
				)
			: await generateTestPrompt(this.ctx.projectName, this.ctx.repoRoot, prdName, config);

		log("info", "Spawning test agent...");
		const result = await this.ctx.agentExecutor.run(prompt, agentConfig, {
			stream: true,
			signal,
			onOutput: (data) => emit({ type: "agent_output", data }),
		});

		emit({ type: "agent_exit", code: result.exitCode });
		log("info", `Agent exit code: ${result.exitCode}`);

		// Parse results
		const report = parseTestReport(result.output, prdName);
		const testResult = detectTestResult(result.output);
		const issues = extractIssues(result.output);

		await saveTestReport(this.ctx.projectName, this.ctx.repoRoot, prdName, report);

		// Helper to run teardown
		const runTeardown = async () => {
			log("info", "Running teardown...");
			await this.runScript(scripts.teardown, "teardown", prdName);
		};

		// Handle result
		if (testResult === "verified") {
			log("info", "PRD_VERIFIED - moving to completed");
			await extractAndSaveFindings(this.ctx.projectName, this.ctx.repoRoot, prdName);

			// Update documentation when enabled — use docs.agent if configured, else fall back to development agentConfig
			const docsConfig = config.docs;
			if (docsConfig?.path && docsConfig.auto_update !== false) {
				const docsPath = join(this.ctx.repoRoot, docsConfig.path);
				let docsAgentConfig = agentConfig;
				if (docsConfig.agent) {
					const dResult = getAgentConfig(config, docsConfig.agent);
					if (dResult.ok) {
						docsAgentConfig = dResult.data!;
					}
				}
				try {
					const { updateDocumentation } = await import("../documentation.js");
					const runAgentFn = async (p: string, c: AgentConfig) => {
						const r = await this.ctx.agentExecutor.run(p, c, { signal });
						return { output: r.output, exitCode: r.exitCode };
					};
					const docResults = await updateDocumentation(
						this.ctx.projectName,
						this.ctx.repoRoot,
						prdName,
						docsPath,
						docsAgentConfig,
						runAgentFn,
					);
					if (docResults.updated.length > 0) {
						log("info", `Documentation updated: ${docResults.updated.join(", ")}`);
					} else if (docResults.skipped.length > 0 || docResults.errors.length > 0) {
						log(
							"warn",
							`Documentation not applied. Skipped: ${docResults.skipped.length}, Errors: ${docResults.errors.length}`,
						);
					}
				} catch (error) {
					log(
						"warn",
						`Documentation update failed: ${error instanceof Error ? error.message : error}`,
					);
				}
			}

			const oldStatus = this.ctx.store.findLocation(prdName) ?? "testing";
			await this.ctx.store.transition(prdName, "completed");
			emit({ type: "state_change", prdName, from: oldStatus, to: "completed" });
			emit({ type: "test_complete", result: "verified" });

			// Auto-commit any uncommitted changes (docs, config, etc.)
			try {
				const commitAgentResult = getAgentConfig(config);
				if (commitAgentResult.ok) {
					const commitPrompt = `Check \`git status\`. If there are any uncommitted changes (staged or unstaged, including untracked files), stage them all and commit using the format: \`feat: [${prdName}] - completion updates\`. If there are no changes, do nothing. Do not push.\n\nWhen done, output:\n<promise>COMPLETE</promise>`;
					log("info", "Checking for uncommitted changes...");
					await this.ctx.agentExecutor.run(commitPrompt, commitAgentResult.data!, {
						signal,
					});
				}
			} catch (error) {
				log("warn", `Auto-commit failed: ${error instanceof Error ? error.message : error}`);
			}

			await runTeardown();

			return ok({
				prdName,
				outcome: "verified",
				report,
			});
		}

		if (testResult === "failed") {
			log("warn", `PRD_FAILED - ${issues.length} issues found`);

			const testResultsRelPath = "test-results/report.md";
			await this.ctx.store.addFixStory(prdName, issues, testResultsRelPath);

			const oldStatus = this.ctx.store.findLocation(prdName) ?? "testing";
			await this.ctx.store.transition(prdName, "in_progress");
			emit({ type: "state_change", prdName, from: oldStatus, to: "in_progress" });
			emit({ type: "test_complete", result: "failed", issues });

			await runTeardown();

			return ok({
				prdName,
				outcome: "failed",
				report,
				issues,
			});
		}

		// Unknown result
		await runTeardown();

		log("warn", "No clear test result signal detected");
		emit({ type: "test_complete", result: "unknown" });

		return ok({
			prdName,
			outcome: "unknown",
			report,
		});
	}

	/**
	 * Run a lifecycle script
	 */
	private async runScript(
		scriptPath: string | undefined,
		name: string,
		prdName?: string,
	): Promise<{ success: boolean; output: string }> {
		if (!scriptPath) {
			return { success: true, output: `${name} not configured` };
		}

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
	 * Wait for health check with polling
	 */
	private async waitForHealthCheck(
		scriptPath: string | undefined,
		timeout: number,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
	): Promise<{ passed: boolean; logs: string }> {
		if (!scriptPath) {
			return { passed: true, logs: "" };
		}

		emit({ type: "health_check_start", timeout });

		const startTime = Date.now();
		const timeoutMs = timeout * 1000;
		let lastFailedOutput = "";

		while (Date.now() - startTime < timeoutMs) {
			if (signal?.aborted) {
				return { passed: false, logs: lastFailedOutput };
			}

			const { success, output } = await this.runScript(scriptPath, "health_check");
			if (success) {
				emit({ type: "health_check_passed" });
				return { passed: true, logs: "" };
			}

			lastFailedOutput = output;
			const elapsed = Math.round((Date.now() - startTime) / 1000);
			emit({ type: "health_check_progress", elapsed, timeout });

			await new Promise((resolve) => setTimeout(resolve, 2000));
		}

		return { passed: false, logs: lastFailedOutput };
	}

	/**
	 * Generate prompt for healthcheck fix agent
	 */
	private generateHealthCheckFixPrompt(
		healthCheckLogs: string,
		config: RalphConfig,
		attempt: number,
		maxAttempts: number,
	): string {
		const projectInstructions =
			config.testing?.project_verification_instructions ||
			"Run project quality checks (lint, typecheck, tests) to ensure code quality.";
		const testingInstructions = config.testing?.instructions || "";
		const scripts = config.scripts;

		return `# Healthcheck Fix Task (Attempt ${attempt}/${maxAttempts})

The application healthcheck is failing. Your job is to diagnose and fix the issue so the healthcheck passes.

## Healthcheck Script Output

The healthcheck script failed with the following output:

\`\`\`
${healthCheckLogs || "(no output captured)"}
\`\`\`

## Project Context

**Project Verification Instructions:** ${projectInstructions}

${testingInstructions ? `**Testing Instructions:** ${testingInstructions}\n` : ""}

## Script Paths

${scripts?.setup ? `- Setup: ${scripts.setup}` : ""}
${scripts?.start ? `- Start: ${scripts.start}` : ""}
${scripts?.health_check ? `- Health check: ${scripts.health_check}` : ""}
${scripts?.teardown ? `- Teardown: ${scripts.teardown}` : ""}

## Instructions

1. Read the healthcheck script to understand what it checks
2. Investigate why the check is failing based on the output above
3. Fix the underlying issue (code, config, dependencies, etc.)
4. Do NOT modify the healthcheck script itself unless it is clearly broken

## CRITICAL: Output Signal

When done, you MUST output exactly one of these signals:

**If you fixed the issue:**
\`\`\`
<healthcheck-result>FIXED</healthcheck-result>
\`\`\`

**If the issue cannot be fixed (infrastructure, external dependency, etc.):**
\`\`\`
<healthcheck-result>NOT_FIXABLE</healthcheck-result>
\`\`\`

Begin diagnosis now.
`;
	}
}

/**
 * Create a new orchestration engine with required project context
 */
export function createEngine(
	ctx: Pick<EngineContext, "projectName" | "repoRoot"> &
		Partial<Omit<EngineContext, "projectName" | "repoRoot">>,
): OrchestrationEngine {
	return new OrchestrationEngine(ctx);
}
