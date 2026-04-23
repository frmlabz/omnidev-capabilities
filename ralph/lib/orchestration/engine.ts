/**
 * Ralph Orchestration Engine
 *
 * Unified orchestration implementation used by both CLI and daemon.
 * Consolidates logic from orchestrator.ts and events.ts.
 */

import { existsSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { resolve } from "node:path";
import { join } from "node:path";
import type { PRD, ProviderVariantConfig, QAReport, RalphConfig } from "../types.js";
import type { Result } from "../results.js";
import { ok, err, ErrorCodes } from "../results.js";
import { type PRDStore, getDefaultStore } from "../core/prd-store.js";
import {
	loadConfig,
	getProviderVariantConfig,
	getScriptsConfig,
	getQAConfig,
	getReviewConfig,
	resolveReviewProviderVariants,
	getStoryVerificationConfig,
	resolveStoryVerifierProviderVariant,
} from "../core/config.js";
import { type Logger, getLogger } from "../core/logger.js";
import { type AgentExecutor, getAgentExecutor } from "./agent-runner.js";
import { generatePrompt } from "../prompt.js";
import {
	generateQAPrompt,
	generateQAPluginPrompt,
	generateQARetestPrompt,
	getPreviousFailures,
	detectQAResult,
	detectHealthCheckResult,
	extractIssues,
	parseQAReport,
	saveQAReport,
} from "../qa.js";
import {
	generateVerification,
	generateSimpleVerification,
	hasVerification,
} from "../verification.js";
import { extractAndSaveFindings } from "../state.js";
import { ReviewEngine } from "./review-engine.js";
import {
	captureCurrentCommit,
	verifyStory,
	generateVerifierFixPrompt,
	getStoryDiff,
	readStoryAcceptanceCriteria,
} from "./story-verifier.js";

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
	| { type: "qa_complete"; result: "verified" | "failed" | "unknown"; issues?: string[] }
	| { type: "error"; error: string }
	| { type: "review_start"; phase: "first" | "external" | "second" | "finalize" }
	| { type: "review_agent_complete"; reviewType: string; decision: string; findingsCount: number }
	| { type: "review_fix_start"; iteration: number; findingsCount: number }
	| { type: "review_phase_complete"; phase: string; clean: boolean }
	| { type: "story_verification_start"; prdName: string; storyId: string }
	| {
			type: "story_verification_complete";
			prdName: string;
			storyId: string;
			pass: boolean;
			failedCount: number;
			skipped: boolean;
	  };

/**
 * Options for running orchestration
 */
export interface RunOptions {
	/** Override the default provider variant */
	providerVariant?: string;
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
	outcome: "moved_to_qa" | "blocked" | "max_iterations" | "aborted";
	message: string;
	storiesCompleted: number;
	storiesRemaining: number;
	reviewPerformed?: boolean;
	reviewFindingsFixed?: number;
}

/**
 * Result of QA run
 */
export interface QARunResult {
	prdName: string;
	outcome: "verified" | "failed" | "unknown" | "health_check_failed";
	report: QAReport;
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
	 * Validate the working directory is a real git repo and resolve the actual branch.
	 * Returns an error if repoRoot is not a valid git working tree.
	 */
	private validateWorkingDirectory(
		prdName: string,
		log: (level: "info" | "warn" | "error", message: string) => void,
	): Result<void> {
		const cwd = this.ctx.repoRoot;

		let gitRoot: string;
		let branch: string;
		try {
			gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", cwd }).trim();
			branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8", cwd }).trim();
		} catch {
			return err("CWD_INVALID", `Working directory "${cwd}" is not a valid git repository`);
		}

		const resolvedCwd = resolve(cwd);
		const resolvedGitRoot = resolve(gitRoot);

		if (resolvedCwd !== resolvedGitRoot) {
			return err(
				"CWD_MISMATCH",
				`repoRoot "${cwd}" resolves to a different git root: "${gitRoot}"`,
			);
		}

		log("info", `PRD: ${prdName} | Branch: ${branch} | Dir: ${cwd}`);

		return ok(undefined);
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

		// Get provider variant config
		const variantResult = getProviderVariantConfig(config, options.providerVariant);
		if (!variantResult.ok) {
			return err(variantResult.error!.code, variantResult.error!.message);
		}
		const agentConfig = variantResult.data!;
		const maxIterations = config.default_iterations;

		// Resolve per-story verifier (optional). When disabled, runs are unchanged.
		const storyVerification = getStoryVerificationConfig(config);
		let storyVerifierVariant: ProviderVariantConfig | null = null;
		if (storyVerification.enabled) {
			const resolved = resolveStoryVerifierProviderVariant(config);
			if (!resolved.ok) {
				log(
					"warn",
					`Per-story verification is enabled but provider variant could not be resolved: ${resolved.error!.message}. Disabling for this run.`,
				);
			} else {
				storyVerifierVariant = resolved.data!;
			}
		}

		log("info", `Starting orchestration for PRD: ${prdName} (cwd: ${process.cwd()})`);
		const cwdCheck = this.validateWorkingDirectory(prdName, log);
		if (!cwdCheck.ok) {
			return err(cwdCheck.error!.code, cwdCheck.error!.message);
		}
		log(
			"info",
			`Using provider variant: ${options.providerVariant ?? config.default_provider_variant}, max iterations: ${maxIterations}`,
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
					outcome: "moved_to_qa",
					message: "PRD moved to QA",
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

			// Mark in progress and update iteration count.
			// Capture the start commit on the first transition so the per-story verifier
			// can diff just this story's work; verifier-reject retries reuse the original.
			await this.ctx.store.update(prdName, (p) => {
				const s = p.stories.find((st) => st.id === story.id);
				if (s) {
					s.status = "in_progress";
					s.iterationCount = iterationCount;
					if (!s.startCommit) {
						const sha = captureCurrentCommit(this.ctx.repoRoot);
						if (sha) {
							s.startCommit = sha;
						}
					}
				}
				return p;
			});
			emit({ type: "story_update", prdName, storyId: story.id, status: "in_progress" });

			log(
				"info",
				`Working on: ${story.id} - ${story.title} (iteration ${iterationCount}, cwd: ${process.cwd()})`,
			);

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

			// Determine this story's status after the agent run
			const updatedPrd = (await this.ctx.store.get(prdName)).data!;
			const updatedStory = updatedPrd.stories.find((s) => s.id === story.id);

			if (updatedStory?.status === "blocked") {
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
			}

			let storyMarkedComplete = updatedStory?.status === "completed";
			if (!storyMarkedComplete) {
				const inferredStatus = this.ctx.agentExecutor.parseStatus(result.output, story.id);
				if (inferredStatus === "completed") {
					log("info", `Inferred story ${story.id} completed from output`);
					await this.ctx.store.updateStoryStatus(prdName, story.id, "completed");
					storyMarkedComplete = true;
				} else if (inferredStatus === "blocked") {
					log("info", `Inferred story ${story.id} blocked from output`);
					await this.ctx.store.updateStoryStatus(prdName, story.id, "blocked", [
						"Agent indicated this story is blocked. Please review the output for details.",
					]);
					emit({ type: "story_update", prdName, storyId: story.id, status: "blocked" });
				}
			}

			if (storyMarkedComplete) {
				// Per-story verifier: check the diff against the story's acceptance criteria
				// before accepting completion. One retry, then block.
				if (storyVerifierVariant) {
					const latestStory = (await this.ctx.store.get(prdName)).data!.stories.find(
						(s) => s.id === story.id,
					)!;
					const storyFilePath = this.ctx.store.getStoryFilePath(prdName, latestStory);
					emit({ type: "story_verification_start", prdName, storyId: story.id });
					const outcome = await verifyStory({
						story: latestStory,
						storyFilePath,
						repoRoot: this.ctx.repoRoot,
						providerVariant: storyVerifierVariant,
						agentExecutor: this.ctx.agentExecutor,
						signal,
					});
					emit({
						type: "story_verification_complete",
						prdName,
						storyId: story.id,
						pass: outcome.pass,
						failedCount: outcome.failedAcs.length,
						skipped: !!outcome.skipped,
					});

					if (!outcome.pass) {
						const acs = readStoryAcceptanceCriteria(storyFilePath);
						const summary = outcome.failedAcs.map((fa) => `${fa.status} AC ${fa.id}`).join(", ");
						log(
							"warn",
							`Story ${story.id} failed verification (${summary}), spawning inline fix agent`,
						);
						const fixPrompt = generateVerifierFixPrompt(
							latestStory,
							storyFilePath,
							acs,
							outcome.failedAcs,
							getStoryDiff(this.ctx.repoRoot, latestStory.startCommit),
						);
						try {
							await this.ctx.agentExecutor.run(fixPrompt, agentConfig, {
								stream: true,
								signal,
								onOutput: (data) => emit({ type: "agent_output", data }),
							});
						} catch (error) {
							log("warn", `Fix agent failed for story ${story.id}: ${error}`);
						}
						// Story stays `completed`. The PRD-level review/QA phase is the
						// deeper safety net; a failing fix agent will surface there.
					}
				}

				log("info", `Story ${story.id} completed`);
				emit({ type: "story_update", prdName, storyId: story.id, status: "completed" });

				// Moving to QA requires BOTH the agent's completion signal AND all stories done
				if (this.ctx.agentExecutor.hasCompletionSignal(result.output)) {
					const isCompleteResult = await this.ctx.store.isComplete(prdName);
					if (isCompleteResult.ok && isCompleteResult.data) {
						log("info", "Agent signaled completion and all stories are done");
						await this.handleDevelopmentComplete(prdName, prd, agentConfig, emit, signal);

						return ok({
							prdName,
							outcome: "moved_to_qa",
							message: "PRD moved to QA",
							storiesCompleted: prd.stories.length,
							storiesRemaining: 0,
						});
					}
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
		agentConfig: ProviderVariantConfig,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		await this.ctx.store.markCompleted(prdName);
		await extractAndSaveFindings(this.ctx.projectName, this.ctx.repoRoot, prdName);

		// Run code review pipeline
		const configResult = await loadConfig();
		if (configResult.ok) {
			const reviewConfig = getReviewConfig(configResult.data!);
			const latestPrdResult = await this.ctx.store.get(prdName);
			const latestPrd = latestPrdResult.ok ? latestPrdResult.data! : _prd;
			// Skip the full review pipeline when this PRD is in a post-failure fix cycle.
			// Agents sometimes hand-edit prd.json and can accidentally drop top-level metadata,
			// so infer the same state from generated FIX stories as a fallback.
			const inferredPostFailureFixCycle = latestPrd.stories.some((story) =>
				story.id.startsWith("FIX-"),
			);
			const shouldRunReview = latestPrd.qaCaughtIssue !== true && !inferredPostFailureFixCycle;

			if (!shouldRunReview) {
				emit({
					type: "log",
					level: "info",
					message:
						latestPrd.qaCaughtIssue === true
							? "Skipping full review pipeline because this PRD is in post-failure fix mode."
							: "Skipping full review pipeline because this PRD has FIX stories from a prior QA failure.",
				});
			}

			if (reviewConfig.enabled && shouldRunReview) {
				const variantsResult = resolveReviewProviderVariants(configResult.data!, reviewConfig);
				if (!variantsResult.ok) {
					emit({
						type: "log",
						level: "warn",
						message: `Failed to resolve review provider variants: ${variantsResult.error?.message}`,
					});
				} else {
					const reviewEngine = new ReviewEngine(this.ctx);
					const prd = latestPrd;
					const result = await reviewEngine.runReview(
						prdName,
						prd,
						configResult.data!,
						variantsResult.data!,
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
		await this.ctx.store.transition(prdName, "qa");
		emit({ type: "state_change", prdName, from: oldStatus, to: "qa" });

		// Generate verification — use verification_provider_variant if configured, else fall back to development variant
		let verificationVariant = agentConfig;
		if (configResult.ok && configResult.data!.verification_provider_variant) {
			const vResult = getProviderVariantConfig(
				configResult.data!,
				configResult.data!.verification_provider_variant,
			);
			if (vResult.ok) {
				verificationVariant = vResult.data!;
			}
		}
		try {
			const runAgentFn = async (prompt: string, config: ProviderVariantConfig) => {
				const result = await this.ctx.agentExecutor.run(prompt, config, { signal });
				return { output: result.output, exitCode: result.exitCode };
			};
			await generateVerification(
				this.ctx.projectName,
				this.ctx.repoRoot,
				prdName,
				verificationVariant,
				runAgentFn,
			);
		} catch {
			await generateSimpleVerification(this.ctx.projectName, this.ctx.repoRoot, prdName);
		}

		await this.ctx.store.updateLastRun(prdName, {
			timestamp: new Date().toISOString(),
			storyId: "ALL",
			reason: "completed",
			summary: "All stories completed. PRD moved to QA.",
		});

		emit({
			type: "complete",
			result: "success",
			message: "PRD moved to QA",
		});
	}

	/**
	 * Run QA for a PRD
	 */
	async runQA(prdName: string, options: RunOptions = {}): Promise<Result<QARunResult>> {
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

		// Get provider variant config
		const variantResult = getProviderVariantConfig(config, options.providerVariant);
		if (!variantResult.ok) {
			return err(variantResult.error!.code, variantResult.error!.message);
		}
		const agentConfig = variantResult.data!;

		const status = this.ctx.store.findLocation(prdName);
		if (!status) {
			return err(ErrorCodes.PRD_NOT_FOUND, `PRD not found: ${prdName}`);
		}

		if (status !== "qa") {
			log("warn", `PRD "${prdName}" is in ${status} status (not qa)`);
		}

		// Ensure verification exists
		if (!hasVerification(this.ctx.projectName, this.ctx.repoRoot, prdName)) {
			log("info", "Generating verification checklist...");
			try {
				const runAgentFn = async (prompt: string, cfg: ProviderVariantConfig) => {
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

		// Check for previous failures (focused reQA)
		const previousFailures = await getPreviousFailures(
			this.ctx.projectName,
			this.ctx.repoRoot,
			prdName,
		);
		const isFocusedRetest = previousFailures !== null && previousFailures.length > 0;

		if (isFocusedRetest) {
			log("info", `Found ${previousFailures.length} previous failure(s) - running focused reQA`);
		} else {
			// Clear previous results only for full QA runs
			this.ctx.store.clearQAResults(prdName);
		}

		log(
			"info",
			`Starting ${isFocusedRetest ? "focused reQA" : "QA"} for PRD: ${prdName} (cwd: ${process.cwd()})`,
		);
		const cwdCheck = this.validateWorkingDirectory(prdName, log);
		if (!cwdCheck.ok) {
			return err(cwdCheck.error!.code, cwdCheck.error!.message);
		}

		// Run scripts
		const scripts = getScriptsConfig(config);
		const qaConfig = getQAConfig(config);
		const healthTimeout = qaConfig.health_check_timeout ?? 30;
		const maxHealthFixAttempts = qaConfig.max_health_fix_attempts ?? 3;

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
			? await generateQARetestPrompt(
					this.ctx.projectName,
					this.ctx.repoRoot,
					prdName,
					previousFailures,
					config,
				)
			: await generateQAPrompt(this.ctx.projectName, this.ctx.repoRoot, prdName, config);

		log("info", `Spawning QA agent (step 1)... (cwd: ${process.cwd()})`);
		const result = await this.ctx.agentExecutor.run(prompt, agentConfig, {
			stream: true,
			signal,
			onOutput: (data) => emit({ type: "agent_output", data }),
		});

		emit({ type: "agent_exit", code: result.exitCode });
		log("info", `Step 1 agent exit code: ${result.exitCode}`);

		// Step 2: platform plugin pass (per FR-5) — only if platforms with plugins are declared
		let combinedOutput = result.output;
		if (!isFocusedRetest) {
			const pluginPrompt = await generateQAPluginPrompt(
				this.ctx.projectName,
				this.ctx.repoRoot,
				prdName,
				config,
				result.output,
			);
			if (pluginPrompt) {
				log("info", "Spawning QA agent (step 2 — platform plugin pass)...");
				const pluginResult = await this.ctx.agentExecutor.run(pluginPrompt, agentConfig, {
					stream: true,
					signal,
					onOutput: (data) => emit({ type: "agent_output", data }),
				});
				emit({ type: "agent_exit", code: pluginResult.exitCode });
				log("info", `Step 2 agent exit code: ${pluginResult.exitCode}`);
				combinedOutput = `${result.output}\n\n${pluginResult.output}`;
			}
		}

		// Parse results
		const report = parseQAReport(combinedOutput, prdName);
		const qaResult = detectQAResult(combinedOutput);
		const issues = extractIssues(combinedOutput);

		await saveQAReport(this.ctx.projectName, this.ctx.repoRoot, prdName, report);

		// Helper to run teardown
		const runTeardown = async () => {
			log("info", "Running teardown...");
			await this.runScript(scripts.teardown, "teardown", prdName);
		};

		// Handle result
		if (qaResult === "verified") {
			log("info", "PRD_VERIFIED - moving to completed");
			await extractAndSaveFindings(this.ctx.projectName, this.ctx.repoRoot, prdName);

			// Update documentation when enabled — use docs.provider_variant if configured, else fall back to development variant
			const docsConfig = config.docs;
			if (docsConfig?.path && docsConfig.auto_update !== false) {
				const docsPath = join(this.ctx.repoRoot, docsConfig.path);
				let docsVariant = agentConfig;
				if (docsConfig.provider_variant) {
					const dResult = getProviderVariantConfig(config, docsConfig.provider_variant);
					if (dResult.ok) {
						docsVariant = dResult.data!;
					}
				}
				try {
					const { updateDocumentation } = await import("../documentation.js");
					const runAgentFn = async (p: string, c: ProviderVariantConfig) => {
						const r = await this.ctx.agentExecutor.run(p, c, { signal });
						return { output: r.output, exitCode: r.exitCode };
					};
					const docResults = await updateDocumentation(
						this.ctx.projectName,
						this.ctx.repoRoot,
						prdName,
						docsPath,
						docsVariant,
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

			const oldStatus = this.ctx.store.findLocation(prdName) ?? "qa";
			await this.ctx.store.transition(prdName, "completed");
			emit({ type: "state_change", prdName, from: oldStatus, to: "completed" });
			emit({ type: "qa_complete", result: "verified" });

			// Auto-commit any uncommitted changes (docs, config, etc.)
			try {
				const commitVariantResult = getProviderVariantConfig(config);
				if (commitVariantResult.ok) {
					const commitPrompt = `Check \`git status\`. If there are any uncommitted changes (staged or unstaged, including untracked files), stage them all and commit using the format: \`feat: [${prdName}] - completion updates\`. If there are no changes, do nothing. Do not push.\n\nWhen done, output:\n<promise>COMPLETE</promise>`;
					log("info", "Checking for uncommitted changes...");
					await this.ctx.agentExecutor.run(commitPrompt, commitVariantResult.data!, {
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

		if (qaResult === "failed") {
			log("warn", `PRD_FAILED - ${issues.length} issues found`);

			const qaResultsRelPath = "qa-results/report.md";
			await this.ctx.store.addFixStory(prdName, issues, qaResultsRelPath);

			const oldStatus = this.ctx.store.findLocation(prdName) ?? "qa";
			await this.ctx.store.transition(prdName, "in_progress");
			emit({ type: "state_change", prdName, from: oldStatus, to: "in_progress" });
			emit({ type: "qa_complete", result: "failed", issues });

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

		log("warn", "No clear QA result signal detected");
		emit({ type: "qa_complete", result: "unknown" });

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
			config.qa?.project_verification_instructions ||
			"Run project quality checks (lint, typecheck, tests) to ensure code quality.";
		const qaInstructions = config.qa?.instructions || "";
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

${qaInstructions ? `**QA Instructions:** ${qaInstructions}\n` : ""}

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
