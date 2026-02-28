/**
 * Ralph Review Engine
 *
 * Multi-phase code review pipeline that runs between development
 * completion and testing. Catches issues early with focused reviewers
 * and resolves them with an inline fix agent.
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getStatusDir } from "../core/paths.js";
import type { PRDStatus } from "../types.js";
import type { EngineContext, EngineEvent } from "./engine.js";
import type {
	PRD,
	AgentConfig,
	RalphConfig,
	ReviewFinding,
	ReviewRoundResult,
	ReviewConfig,
} from "../types.js";
import type { Result } from "../results.js";
import { ok } from "../results.js";
import { getAgentConfig, type ResolvedReviewAgents } from "../core/config.js";
import {
	generateReviewPrompt,
	generateFixPrompt,
	generateExternalReviewPrompt,
	generateFinalizePrompt,
	parseReviewResult,
} from "../review-prompt.js";

/**
 * Get git diff for the PRD's changes
 */
function getGitDiff(): string {
	try {
		// Get diff of all changes on current branch vs merge-base with main
		const mergeBase = execSync(
			"git merge-base HEAD main 2>/dev/null || git rev-parse HEAD~10 2>/dev/null || echo HEAD",
			{ encoding: "utf-8" },
		).trim();
		return execSync(`git diff ${mergeBase} HEAD`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch {
		// Fallback: diff of staged + unstaged changes
		try {
			return execSync("git diff HEAD", { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
		} catch {
			return "(unable to generate git diff)";
		}
	}
}

/**
 * Get the review results directory for a PRD
 */
function getReviewResultsDir(
	projectName: string,
	repoRoot: string,
	prdName: string,
	prdStatus: string,
): string {
	return join(
		getStatusDir(projectName, repoRoot, prdStatus as PRDStatus),
		prdName,
		"review-results",
	);
}

/**
 * Format findings into markdown for saving
 */
function formatReviewResultsMarkdown(
	phase: string,
	results: ReviewRoundResult[],
	fixIterations: number,
): string {
	let md = `# ${phase} Review Results\n\n`;
	md += `**Date:** ${new Date().toISOString()}\n`;
	md += `**Fix iterations:** ${fixIterations}\n\n`;

	for (const result of results) {
		md += `## ${result.reviewType}\n\n`;
		md += `**Decision:** ${result.decision}\n\n`;

		if (result.findings.length > 0) {
			md += `**Findings:**\n\n`;
			for (const f of result.findings) {
				md += `- [${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.issue}\n`;
			}
			md += "\n";
		} else {
			md += "No findings.\n\n";
		}
	}

	return md;
}

/**
 * Review Engine - orchestrates the multi-phase review pipeline
 */
export class ReviewEngine {
	private ctx: EngineContext;

	constructor(ctx: EngineContext) {
		this.ctx = ctx;
	}

	/**
	 * Run the full review pipeline
	 */
	async runReview(
		prdName: string,
		prd: PRD,
		config: RalphConfig,
		agents: ResolvedReviewAgents,
		reviewConfig: Required<ReviewConfig>,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
	): Promise<Result<void>> {
		const log = (level: "info" | "warn" | "error", message: string) => {
			this.ctx.logger.log(level, message, { prdName });
			emit({ type: "log", level, message });
		};

		const prdStatus = this.ctx.store.findLocation(prdName) ?? "in_progress";
		const resultsDir = getReviewResultsDir(
			this.ctx.projectName,
			this.ctx.repoRoot,
			prdName,
			prdStatus,
		);
		mkdirSync(resultsDir, { recursive: true });

		const gitDiff = getGitDiff();
		if (gitDiff.length < 10) {
			log("info", "No significant changes detected in git diff, skipping review");
			return ok(undefined);
		}

		// Phase 1: First code review
		log("info", "Starting Phase 1: First Code Review");
		emit({ type: "review_start", phase: "first" });

		const firstResults = await this.runReviewRound(
			prdName,
			prd,
			reviewConfig.first_review_agents,
			agents.reviewAgent,
			agents.fixAgent,
			gitDiff,
			false,
			emit,
			signal,
			reviewConfig.max_fix_iterations,
		);

		await writeFile(
			join(resultsDir, "first-review.md"),
			formatReviewResultsMarkdown("First", firstResults.results, firstResults.fixIterations),
		);

		emit({ type: "review_phase_complete", phase: "first", clean: firstResults.clean });
		log("info", `Phase 1 complete: ${firstResults.clean ? "clean" : "findings fixed"}`);

		// Phase 2: External review (optional)
		if (reviewConfig.review_agent) {
			log("info", `Starting Phase 2: External Review (${reviewConfig.review_agent})`);
			emit({ type: "review_start", phase: "external" });

			const externalResult = await this.runExternalReview(
				prdName,
				prd,
				config,
				agents.fixAgent,
				reviewConfig,
				gitDiff,
				emit,
				signal,
			);

			if (externalResult) {
				await writeFile(
					join(resultsDir, "external-review.md"),
					formatReviewResultsMarkdown(
						"External",
						externalResult.results,
						externalResult.fixIterations,
					),
				);
			}

			emit({
				type: "review_phase_complete",
				phase: "external",
				clean: externalResult?.clean ?? true,
			});
			log("info", "Phase 2 complete");
		}

		// Phase 3: Second code review (critical only)
		log("info", "Starting Phase 3: Second Code Review (critical/major only)");
		emit({ type: "review_start", phase: "second" });

		const secondResults = await this.runReviewRound(
			prdName,
			prd,
			reviewConfig.second_review_agents,
			agents.reviewAgent,
			agents.fixAgent,
			getGitDiff(), // Re-get diff after fixes
			true, // second review — critical only
			emit,
			signal,
			reviewConfig.max_fix_iterations,
		);

		await writeFile(
			join(resultsDir, "second-review.md"),
			formatReviewResultsMarkdown("Second", secondResults.results, secondResults.fixIterations),
		);

		emit({ type: "review_phase_complete", phase: "second", clean: secondResults.clean });
		log("info", `Phase 3 complete: ${secondResults.clean ? "clean" : "findings fixed"}`);

		// Phase 4: Finalize (optional)
		if (reviewConfig.finalize_enabled) {
			log("info", "Starting Phase 4: Finalize");
			emit({ type: "review_start", phase: "finalize" });

			await this.runFinalize(prdName, prd, agents.finalizeAgent, reviewConfig, emit, signal);

			emit({ type: "review_phase_complete", phase: "finalize", clean: true });
			log("info", "Phase 4 complete");
		}

		return ok(undefined);
	}

	/**
	 * Run a review round with N agents in parallel, then fix findings
	 */
	private async runReviewRound(
		prdName: string,
		prd: PRD,
		reviewTypes: string[],
		reviewAgentConfig: AgentConfig,
		fixAgentConfig: AgentConfig,
		gitDiff: string,
		isSecondReview: boolean,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
		maxFixIterations = 3,
	): Promise<{ results: ReviewRoundResult[]; fixIterations: number; clean: boolean }> {
		for (let fixIteration = 0; fixIteration <= maxFixIterations; fixIteration++) {
			if (signal?.aborted) {
				return { results: [], fixIterations: fixIteration, clean: false };
			}

			// Run all review agents in parallel
			const reviewPromises = reviewTypes.map(async (reviewType) => {
				try {
					const prompt = await generateReviewPrompt(
						this.ctx.projectName,
						this.ctx.repoRoot,
						prdName,
						reviewType,
						prd,
						gitDiff,
						isSecondReview,
					);
					const result = await this.ctx.agentExecutor.run(prompt, reviewAgentConfig, {
						stream: true,
						signal,
						onOutput: (data) => emit({ type: "agent_output", data }),
					});

					const parsed = parseReviewResult(result.output, reviewType);
					emit({
						type: "review_agent_complete",
						reviewType,
						decision: parsed.decision,
						findingsCount: parsed.findings.length,
					});
					return parsed;
				} catch (error) {
					this.ctx.logger.log("warn", `Review agent ${reviewType} failed: ${error}`, { prdName });
					return {
						reviewType,
						decision: "approve" as const,
						findings: [],
					};
				}
			});

			const results = await Promise.all(reviewPromises);

			// Collect actionable findings
			let findings = results.flatMap((r) => r.findings);
			if (isSecondReview) {
				findings = findings.filter((f) => f.severity === "critical" || f.severity === "major");
			}

			const criticalOrMajor = findings.filter(
				(f) => f.severity === "critical" || f.severity === "major",
			);

			if (criticalOrMajor.length === 0) {
				return { results, fixIterations: fixIteration, clean: fixIteration === 0 };
			}

			// If we've exhausted fix iterations, return with remaining findings
			if (fixIteration >= maxFixIterations) {
				this.ctx.logger.log(
					"warn",
					`Max fix iterations (${maxFixIterations}) reached with ${criticalOrMajor.length} remaining findings`,
					{ prdName },
				);
				return { results, fixIterations: fixIteration, clean: false };
			}

			// Run fix agent
			emit({
				type: "review_fix_start",
				iteration: fixIteration + 1,
				findingsCount: criticalOrMajor.length,
			});
			await this.runFixAgent(prdName, prd, criticalOrMajor, fixAgentConfig, emit, signal);

			// Re-get diff for next review iteration
			gitDiff = getGitDiff();
		}

		return { results: [], fixIterations: maxFixIterations, clean: false };
	}

	/**
	 * Run the fix agent to resolve findings
	 */
	private async runFixAgent(
		prdName: string,
		prd: PRD,
		findings: ReviewFinding[],
		agentConfig: AgentConfig,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const prompt = generateFixPrompt(prdName, prd, findings);

		try {
			await this.ctx.agentExecutor.run(prompt, agentConfig, {
				stream: true,
				signal,
				onOutput: (data) => emit({ type: "agent_output", data }),
			});
		} catch (error) {
			this.ctx.logger.log("warn", `Fix agent failed: ${error}`, { prdName });
		}
	}

	/**
	 * Run external review (codex or custom tool)
	 */
	private async runExternalReview(
		prdName: string,
		prd: PRD,
		config: RalphConfig,
		fixAgentConfig: AgentConfig,
		reviewConfig: Required<ReviewConfig>,
		gitDiff: string,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
	): Promise<{ results: ReviewRoundResult[]; fixIterations: number; clean: boolean } | null> {
		// Look up the external tool agent config
		const externalAgentResult = getAgentConfig(config, reviewConfig.review_agent);
		const externalAgentConfig = externalAgentResult.ok ? externalAgentResult.data! : fixAgentConfig;

		if (!externalAgentResult.ok) {
			this.ctx.logger.log(
				"warn",
				`Review agent '${reviewConfig.review_agent}' not found in config, using default agent`,
				{ prdName },
			);
		}

		const prompt = generateExternalReviewPrompt(prdName, prd, gitDiff);

		try {
			const result = await this.ctx.agentExecutor.run(prompt, externalAgentConfig, {
				stream: true,
				signal,
				onOutput: (data) => emit({ type: "agent_output", data }),
			});

			const parsed = parseReviewResult(result.output, `external-${reviewConfig.review_agent}`);
			emit({
				type: "review_agent_complete",
				reviewType: `external-${reviewConfig.review_agent}`,
				decision: parsed.decision,
				findingsCount: parsed.findings.length,
			});

			const criticalOrMajor = parsed.findings.filter(
				(f) => f.severity === "critical" || f.severity === "major",
			);

			if (criticalOrMajor.length > 0) {
				emit({ type: "review_fix_start", iteration: 1, findingsCount: criticalOrMajor.length });
				await this.runFixAgent(prdName, prd, criticalOrMajor, fixAgentConfig, emit, signal);
				return { results: [parsed], fixIterations: 1, clean: false };
			}

			return { results: [parsed], fixIterations: 0, clean: true };
		} catch (error) {
			this.ctx.logger.log("warn", `External review failed: ${error}`, { prdName });
			return null;
		}
	}

	/**
	 * Run the finalize step
	 */
	private async runFinalize(
		prdName: string,
		prd: PRD,
		agentConfig: AgentConfig,
		reviewConfig: Required<ReviewConfig>,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
	): Promise<void> {
		const prompt = generateFinalizePrompt(prdName, prd, reviewConfig.finalize_prompt || undefined);

		try {
			await this.ctx.agentExecutor.run(prompt, agentConfig, {
				stream: true,
				signal,
				onOutput: (data) => emit({ type: "agent_output", data }),
			});
		} catch (error) {
			this.ctx.logger.log("warn", `Finalize step failed: ${error}`, { prdName });
		}
	}
}
