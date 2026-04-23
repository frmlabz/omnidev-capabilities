/**
 * Ralph Zod Schemas
 *
 * Validation schemas for all Ralph data structures.
 * These provide runtime validation and type inference.
 */

import { z } from "zod";

export const StoryStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked"]);

export const PRDStatusSchema = z.enum(["pending", "in_progress", "qa", "completed"]);

export const StorySchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	promptPath: z.string().min(1),
	status: StoryStatusSchema,
	priority: z.number().int().min(1),
	questions: z.array(z.string()).default([]),
	answers: z.array(z.string()).optional(),
	iterationCount: z.number().int().min(0).optional(),
});

export const LastRunSchema = z.object({
	timestamp: z.string().datetime(),
	storyId: z.string(),
	reason: z.enum(["user_interrupted", "completed", "story_completed", "blocked", "error"]),
	summary: z.string(),
});

export const PRDMetricsSchema = z.object({
	totalTokens: z.number().int().min(0).optional(),
	inputTokens: z.number().int().min(0).optional(),
	outputTokens: z.number().int().min(0).optional(),
	iterations: z.number().int().min(0).optional(),
});

export const PRDSchema = z.object({
	name: z.string().min(1),
	description: z.string(),
	createdAt: z.string().datetime(),
	startedAt: z.string().datetime().optional(),
	completedAt: z.string().datetime().optional(),
	stories: z.array(StorySchema).min(1),
	dependencies: z.array(z.string()).optional(),
	qaCaughtIssue: z.boolean().optional(),
	lastRun: LastRunSchema.optional(),
	metrics: PRDMetricsSchema.optional(),
});

export const ProviderVariantConfigSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()),
});

export const QAPlatformConfigSchema = z.object({
	plugin: z.string().min(1).optional(),
});

export const QAConfigSchema = z.object({
	project_verification_instructions: z.string().optional(),
	qa_iterations: z.number().int().min(1).optional(),
	instructions: z.string().optional(),
	health_check_timeout: z.number().int().min(1).optional(),
	max_health_fix_attempts: z.number().int().min(1).max(10).optional(),
	platforms: z.record(z.string(), QAPlatformConfigSchema).optional(),
});

export const ScriptsConfigSchema = z.object({
	setup: z.string().optional(),
	start: z.string().optional(),
	health_check: z.string().optional(),
	teardown: z.string().optional(),
});

export const DocsConfigSchema = z.object({
	path: z.string().min(1),
	auto_update: z.boolean().optional().default(true),
	provider_variant: z.string().optional(),
});

export const ReviewConfigSchema = z.object({
	enabled: z.boolean().optional(),
	provider_variant: z.string().optional(),
	fix_provider_variant: z.string().optional(),
	finalize_provider_variant: z.string().optional(),
	review_provider_variant: z.string().optional(),
	finalize_enabled: z.boolean().optional(),
	finalize_prompt: z.string().optional(),
	first_review_agents: z.array(z.string()).optional(),
	second_review_agents: z.array(z.string()).optional(),
	max_fix_iterations: z.number().int().min(1).max(10).optional(),
	todo_file: z.string().min(1).optional(),
});

export const SwarmConfigSchema = z.object({
	worktree_parent: z.string().optional(),
	panes_per_window: z.number().int().min(1).max(16).optional(),
	pane_close_timeout: z.number().int().min(0).optional(),
	worktree_create_cmd: z.string().min(1).optional(),
	primary_branch: z.string().min(1).optional(),
	merge_provider_variant: z.string().min(1).optional(),
});

export const RalphConfigSchema = z.object({
	project_name: z
		.string()
		.min(1)
		.max(64)
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
			"Must be a lowercase slug (a-z, 0-9, hyphens; no leading/trailing hyphens)",
		),
	default_provider_variant: z.string().min(1),
	default_iterations: z.number().int().min(1),
	provider_variants: z.record(z.string(), ProviderVariantConfigSchema),
	verification_provider_variant: z.string().optional(),
	qa: QAConfigSchema.optional(),
	scripts: ScriptsConfigSchema.optional(),
	docs: DocsConfigSchema.optional(),
	review: ReviewConfigSchema.optional(),
	swarm: SwarmConfigSchema.optional(),
});

export const QAResultSchema = z.object({
	item: z.string(),
	passed: z.boolean(),
	reason: z.string().optional(),
	details: z.string().optional(),
});

export const QAReportSchema = z.object({
	prdName: z.string(),
	timestamp: z.string().datetime(),
	qaResults: z.array(QAResultSchema),
	summary: z.object({
		total: z.number().int().min(0),
		passed: z.number().int().min(0),
		failed: z.number().int().min(0),
	}),
	agentOutput: z.string().optional(),
});

export const QAIssueSchema = z.object({
	id: z.string(),
	description: z.string(),
	screenshot: z.string().optional(),
	severity: z.enum(["critical", "major", "minor"]).optional(),
});

export const DependencyInfoSchema = z.object({
	name: z.string(),
	status: PRDStatusSchema,
	dependencies: z.array(z.string()),
	isComplete: z.boolean(),
	canStart: z.boolean(),
	unmetDependencies: z.array(z.string()),
});

export const PRDSummarySchema = z.object({
	name: z.string(),
	status: PRDStatusSchema,
	description: z.string(),
	progress: z.object({
		completed: z.number().int().min(0),
		total: z.number().int().min(0),
		inProgress: z.number().int().min(0),
		blocked: z.number().int().min(0),
	}),
	canStart: z.boolean(),
	hasBlockedStories: z.boolean(),
	dependencies: z.array(z.string()),
	unmetDependencies: z.array(z.string()),
	startedAt: z.string().datetime().optional(),
	completedAt: z.string().datetime().optional(),
	metrics: PRDMetricsSchema.optional(),
});

// Inferred types from schemas
export type StoryStatusZ = z.infer<typeof StoryStatusSchema>;
export type PRDStatusZ = z.infer<typeof PRDStatusSchema>;
export type StoryZ = z.infer<typeof StorySchema>;
export type LastRunZ = z.infer<typeof LastRunSchema>;
export type PRDMetricsZ = z.infer<typeof PRDMetricsSchema>;
export type PRDZ = z.infer<typeof PRDSchema>;
export type ProviderVariantConfigZ = z.infer<typeof ProviderVariantConfigSchema>;
export type QAPlatformConfigZ = z.infer<typeof QAPlatformConfigSchema>;
export type QAConfigZ = z.infer<typeof QAConfigSchema>;
export type ScriptsConfigZ = z.infer<typeof ScriptsConfigSchema>;
export type DocsConfigZ = z.infer<typeof DocsConfigSchema>;
export type ReviewConfigZ = z.infer<typeof ReviewConfigSchema>;
export type SwarmConfigZ = z.infer<typeof SwarmConfigSchema>;
export type RalphConfigZ = z.infer<typeof RalphConfigSchema>;
export type QAResultZ = z.infer<typeof QAResultSchema>;
export type QAReportZ = z.infer<typeof QAReportSchema>;
export type QAIssueZ = z.infer<typeof QAIssueSchema>;
export type DependencyInfoZ = z.infer<typeof DependencyInfoSchema>;
export type PRDSummaryZ = z.infer<typeof PRDSummarySchema>;

/**
 * Validate a PRD object
 */
export function validatePRD(
	data: unknown,
): { success: true; data: PRDZ } | { success: false; error: z.ZodError } {
	const result = PRDSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}

/**
 * Validate a Story object
 */
export function validateStory(
	data: unknown,
): { success: true; data: StoryZ } | { success: false; error: z.ZodError } {
	const result = StorySchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}

/**
 * Validate a RalphConfig object
 */
export function validateRalphConfig(
	data: unknown,
): { success: true; data: RalphConfigZ } | { success: false; error: z.ZodError } {
	const result = RalphConfigSchema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}
