/**
 * Ralph Review Engine
 *
 * Multi-phase code review pipeline that runs between development
 * completion and testing. Catches issues early with focused reviewers
 * and resolves them with an inline fix agent.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { getStatusDir } from "../core/paths.js";
import type { PRDStatus } from "../types.js";
import type { EngineContext, EngineEvent } from "./engine.js";
import type {
	PRD,
	ProviderVariantConfig,
	RalphConfig,
	ReviewFinding,
	ReviewRoundResult,
	ReviewConfig,
} from "../types.js";
import type { Result } from "../results.js";
import { ok } from "../results.js";
import { atomicWrite } from "../core/paths.js";
import { getProviderVariantConfig, type ResolvedReviewProviderVariants } from "../core/config.js";
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

const FINDING_SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
	critical: 0,
	major: 1,
	minor: 2,
	suggestion: 3,
};

function normalizeFindingKey(finding: ReviewFinding): string {
	return `${finding.file}|${finding.line ?? ""}|${finding.issue.trim().toLowerCase()}`;
}

function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
	const deduped = new Map<string, ReviewFinding>();

	for (const finding of findings) {
		const key = normalizeFindingKey(finding);
		const existing = deduped.get(key);
		if (!existing) {
			deduped.set(key, { ...finding });
			continue;
		}

		if (FINDING_SEVERITY_RANK[finding.severity] < FINDING_SEVERITY_RANK[existing.severity]) {
			existing.severity = finding.severity;
		}

		const reviewers = new Set(existing.reviewer.split(", ").filter(Boolean));
		reviewers.add(finding.reviewer);
		existing.reviewer = Array.from(reviewers).join(", ");
	}

	return Array.from(deduped.values());
}

function classifyFindings(findings: ReviewFinding[]): {
	blockers: ReviewFinding[];
	followUps: ReviewFinding[];
	noise: ReviewFinding[];
} {
	const deduped = dedupeFindings(findings);
	return {
		blockers: deduped.filter((f) => f.severity === "critical" || f.severity === "major"),
		followUps: deduped.filter((f) => f.severity === "minor"),
		noise: deduped.filter((f) => f.severity === "suggestion"),
	};
}

function formatTodoFinding(finding: ReviewFinding): string {
	return `- [${finding.severity.toUpperCase()}] ${finding.file}${finding.line ? `:${finding.line}` : ""} — ${finding.issue} (reviewer: ${finding.reviewer})`;
}

function formatTodoBlock(
	prdName: string,
	followUps: ReviewFinding[],
	noise: ReviewFinding[],
): string {
	if (followUps.length === 0 && noise.length === 0) {
		return "";
	}

	const lines = [
		`<!-- ralph-review-todos:${prdName}:start -->`,
		`## ${prdName}`,
		"",
		`Updated: ${new Date().toISOString()}`,
		"",
	];

	if (followUps.length > 0) {
		lines.push("### Follow-Ups", "");
		for (const finding of followUps) {
			lines.push(formatTodoFinding(finding));
		}
		lines.push("");
	}

	if (noise.length > 0) {
		lines.push("### Noise / Suggestions", "");
		for (const finding of noise) {
			lines.push(formatTodoFinding(finding));
		}
		lines.push("");
	}

	lines.push(`<!-- ralph-review-todos:${prdName}:end -->`);
	return `${lines.join("\n")}\n`;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
		variants: ResolvedReviewProviderVariants,
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

		const externalProviderVariantConfig = this.resolveExternalReviewVariant(
			prdName,
			config,
			variants.fixVariant,
			reviewConfig,
		);

		// Phase 1: Aggregated first-pass review
		log("info", "Starting Phase 1: Aggregated Code Review");
		emit({ type: "review_start", phase: "first" });

		const firstResults = await this.runReviewRound(
			prdName,
			prd,
			reviewConfig.first_review_agents,
			variants.reviewVariant,
			variants.fixVariant,
			gitDiff,
			false,
			emit,
			signal,
			reviewConfig.max_fix_iterations,
			reviewConfig.review_provider_variant
				? {
						reviewType: `external-${reviewConfig.review_provider_variant}`,
						agentConfig: externalProviderVariantConfig,
					}
				: undefined,
		);

		await writeFile(
			join(resultsDir, "first-review.md"),
			formatReviewResultsMarkdown("First", firstResults.results, firstResults.fixIterations),
		);

		emit({ type: "review_phase_complete", phase: "first", clean: firstResults.clean });
		log("info", `Phase 1 complete: ${firstResults.clean ? "clean" : "findings fixed"}`);

		// Phase 2: Targeted verification review (critical only)
		log("info", "Starting Phase 2: Targeted Verification Review (critical/major only)");
		emit({ type: "review_start", phase: "second" });

		const secondResults = await this.runReviewRound(
			prdName,
			prd,
			reviewConfig.second_review_agents,
			variants.reviewVariant,
			variants.fixVariant,
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
		log("info", `Phase 2 complete: ${secondResults.clean ? "clean" : "findings fixed"}`);

		await this.writeTodoFindings(
			prdName,
			reviewConfig,
			[
				...firstResults.followUps,
				...firstResults.noise,
				...secondResults.followUps,
				...secondResults.noise,
			],
			log,
		);

		// Phase 3: Finalize (optional)
		if (reviewConfig.finalize_enabled) {
			log("info", "Starting Phase 3: Finalize");
			emit({ type: "review_start", phase: "finalize" });

			await this.runFinalize(prdName, prd, variants.finalizeVariant, reviewConfig, emit, signal);

			emit({ type: "review_phase_complete", phase: "finalize", clean: true });
			log("info", "Phase 3 complete");
		}

		return ok(undefined);
	}

	private resolveExternalReviewVariant(
		prdName: string,
		config: RalphConfig,
		fallbackVariant: ProviderVariantConfig,
		reviewConfig: Required<ReviewConfig>,
	): ProviderVariantConfig {
		if (!reviewConfig.review_provider_variant) {
			return fallbackVariant;
		}

		const externalResult = getProviderVariantConfig(config, reviewConfig.review_provider_variant);
		if (!externalResult.ok) {
			this.ctx.logger.log(
				"warn",
				`Review provider variant '${reviewConfig.review_provider_variant}' not found in config, using fallback variant`,
				{ prdName },
			);
			return fallbackVariant;
		}

		return externalResult.data!;
	}

	/**
	 * Run a review round with N agents in parallel, then fix findings
	 */
	private async runReviewRound(
		prdName: string,
		prd: PRD,
		reviewTypes: string[],
		reviewProviderVariantConfig: ProviderVariantConfig,
		fixProviderVariantConfig: ProviderVariantConfig,
		gitDiff: string,
		isSecondReview: boolean,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
		maxFixIterations = 3,
		externalReview?: { reviewType: string; agentConfig: ProviderVariantConfig },
	): Promise<{
		results: ReviewRoundResult[];
		fixIterations: number;
		clean: boolean;
		followUps: ReviewFinding[];
		noise: ReviewFinding[];
	}> {
		for (let fixIteration = 0; fixIteration <= maxFixIterations; fixIteration++) {
			if (signal?.aborted) {
				return {
					results: [],
					fixIterations: fixIteration,
					clean: false,
					followUps: [],
					noise: [],
				};
			}

			const results = await this.runReviewerBatch(
				prdName,
				prd,
				reviewTypes,
				reviewProviderVariantConfig,
				gitDiff,
				isSecondReview,
				emit,
				signal,
				externalReview,
			);
			const classified = classifyFindings(results.flatMap((r) => r.findings));

			if (classified.blockers.length === 0) {
				return {
					results,
					fixIterations: fixIteration,
					clean: fixIteration === 0,
					followUps: classified.followUps,
					noise: classified.noise,
				};
			}

			// If we've exhausted fix iterations, return with remaining findings
			if (fixIteration >= maxFixIterations) {
				this.ctx.logger.log(
					"warn",
					`Max fix iterations (${maxFixIterations}) reached with ${classified.blockers.length} remaining findings`,
					{ prdName },
				);
				return {
					results,
					fixIterations: fixIteration,
					clean: false,
					followUps: classified.followUps,
					noise: classified.noise,
				};
			}

			// Run fix agent
			emit({
				type: "review_fix_start",
				iteration: fixIteration + 1,
				findingsCount: classified.blockers.length,
			});
			await this.runFixAgent(
				prdName,
				prd,
				classified.blockers,
				fixProviderVariantConfig,
				emit,
				signal,
			);

			// Re-get diff for next review iteration
			gitDiff = getGitDiff();
		}

		return {
			results: [],
			fixIterations: maxFixIterations,
			clean: false,
			followUps: [],
			noise: [],
		};
	}

	private async runReviewerBatch(
		prdName: string,
		prd: PRD,
		reviewTypes: string[],
		reviewProviderVariantConfig: ProviderVariantConfig,
		gitDiff: string,
		isSecondReview: boolean,
		emit: (event: EngineEvent) => void,
		signal?: AbortSignal,
		externalReview?: { reviewType: string; agentConfig: ProviderVariantConfig },
	): Promise<ReviewRoundResult[]> {
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
				const result = await this.ctx.agentExecutor.run(prompt, reviewProviderVariantConfig, {
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

		if (externalReview) {
			reviewPromises.push(
				(async () => {
					try {
						const prompt = generateExternalReviewPrompt(
							this.ctx.projectName,
							this.ctx.repoRoot,
							prdName,
							prd,
							gitDiff,
						);
						const result = await this.ctx.agentExecutor.run(prompt, externalReview.agentConfig, {
							stream: true,
							signal,
							onOutput: (data) => emit({ type: "agent_output", data }),
						});
						const parsed = parseReviewResult(result.output, externalReview.reviewType);
						emit({
							type: "review_agent_complete",
							reviewType: externalReview.reviewType,
							decision: parsed.decision,
							findingsCount: parsed.findings.length,
						});
						return parsed;
					} catch (error) {
						this.ctx.logger.log(
							"warn",
							`Review agent ${externalReview.reviewType} failed: ${error}`,
							{
								prdName,
							},
						);
						return {
							reviewType: externalReview.reviewType,
							decision: "approve" as const,
							findings: [],
						};
					}
				})(),
			);
		}

		return Promise.all(reviewPromises);
	}

	/**
	 * Run the fix agent to resolve findings
	 */
	private async runFixAgent(
		prdName: string,
		prd: PRD,
		findings: ReviewFinding[],
		agentConfig: ProviderVariantConfig,
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

	private async writeTodoFindings(
		prdName: string,
		reviewConfig: Required<ReviewConfig>,
		findings: ReviewFinding[],
		log: (level: "info" | "warn" | "error", message: string) => void,
	): Promise<void> {
		if (!reviewConfig.todo_file) {
			return;
		}

		const { followUps, noise } = classifyFindings(findings);
		const todoPath = isAbsolute(reviewConfig.todo_file)
			? reviewConfig.todo_file
			: join(this.ctx.repoRoot, reviewConfig.todo_file);
		const startMarker = `<!-- ralph-review-todos:${prdName}:start -->`;
		const endMarker = `<!-- ralph-review-todos:${prdName}:end -->`;
		const blockPattern = new RegExp(
			`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`,
			"g",
		);
		const existing = existsSync(todoPath)
			? await readFile(todoPath, "utf-8")
			: "# Ralph Review TODOs\n\n";
		let next = existing.replace(blockPattern, "").trimEnd();
		const block = formatTodoBlock(prdName, followUps, noise).trimEnd();

		if (block) {
			next = `${next}\n\n${block}`.trim();
		}

		await atomicWrite(todoPath, `${next}\n`);
		log(
			"info",
			block
				? `Saved ${followUps.length + noise.length} non-blocking review findings to ${todoPath}`
				: `Cleared resolved non-blocking review findings from ${todoPath}`,
		);
	}

	/**
	 * Run the finalize step
	 */
	private async runFinalize(
		prdName: string,
		prd: PRD,
		agentConfig: ProviderVariantConfig,
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
