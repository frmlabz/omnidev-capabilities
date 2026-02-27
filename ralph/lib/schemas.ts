/**
 * Ralph Zod Schemas
 *
 * Validation schemas for all Ralph data structures.
 * These provide runtime validation and type inference.
 */

import { z } from "zod";

/**
 * Story status enum
 */
export const StoryStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked"]);

/**
 * PRD status enum
 */
export const PRDStatusSchema = z.enum(["pending", "in_progress", "testing", "completed"]);

/**
 * Story schema - a chunk of work within a PRD
 */
export const StorySchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	acceptanceCriteria: z.array(z.string()),
	status: StoryStatusSchema,
	priority: z.number().int().min(1),
	questions: z.array(z.string()).default([]),
	answers: z.array(z.string()).optional(),
	iterationCount: z.number().int().min(0).optional(),
});

/**
 * Last run information - captured on Ctrl+C or completion
 */
export const LastRunSchema = z.object({
	timestamp: z.string().datetime(),
	storyId: z.string(),
	reason: z.enum(["user_interrupted", "completed", "story_completed", "blocked", "error"]),
	summary: z.string(),
});

/**
 * PRD metrics schema
 */
export const PRDMetricsSchema = z.object({
	totalTokens: z.number().int().min(0).optional(),
	inputTokens: z.number().int().min(0).optional(),
	outputTokens: z.number().int().min(0).optional(),
	iterations: z.number().int().min(0).optional(),
});

/**
 * PRD schema - Product Requirements Document
 */
export const PRDSchema = z.object({
	name: z.string().min(1),
	description: z.string(),
	createdAt: z.string().datetime(),
	startedAt: z.string().datetime().optional(),
	completedAt: z.string().datetime().optional(),
	stories: z.array(StorySchema).min(1),
	dependencies: z.array(z.string()).optional(),
	lastRun: LastRunSchema.optional(),
	metrics: PRDMetricsSchema.optional(),
});

/**
 * Agent configuration schema
 */
export const AgentConfigSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()),
});

/**
 * Testing configuration schema
 */
export const TestingConfigSchema = z.object({
	project_verification_instructions: z.string().optional(),
	test_iterations: z.number().int().min(1).optional(),
	web_testing_enabled: z.boolean().optional(),
	instructions: z.string().optional(),
	health_check_timeout: z.number().int().min(1).optional(),
	max_health_fix_attempts: z.number().int().min(1).max(10).optional(),
});

/**
 * Scripts configuration schema
 */
export const ScriptsConfigSchema = z.object({
	setup: z.string().optional(),
	start: z.string().optional(),
	health_check: z.string().optional(),
	teardown: z.string().optional(),
});

/**
 * Documentation configuration schema
 */
export const DocsConfigSchema = z.object({
	path: z.string().min(1),
	auto_update: z.boolean().optional().default(true),
	agent: z.string().optional(),
});

/**
 * Review configuration schema
 */
export const ReviewConfigSchema = z.object({
	enabled: z.boolean().optional(),
	agent: z.string().optional(),
	fix_agent: z.string().optional(),
	finalize_agent: z.string().optional(),
	review_agent: z.string().optional(),
	finalize_enabled: z.boolean().optional(),
	finalize_prompt: z.string().optional(),
	first_review_agents: z.array(z.string()).optional(),
	second_review_agents: z.array(z.string()).optional(),
	max_fix_iterations: z.number().int().min(1).max(10).optional(),
});

/**
 * Swarm configuration schema
 */
export const SwarmConfigSchema = z.object({
	worktree_parent: z.string().optional(),
	panes_per_window: z.number().int().min(1).max(16).optional(),
	pane_close_timeout: z.number().int().min(0).optional(),
	worktree_create_cmd: z.string().min(1).optional(),
	primary_branch: z.string().min(1).optional(),
	merge_agent: z.string().min(1).optional(),
});

/**
 * Ralph configuration schema
 */
export const RalphConfigSchema = z.object({
	project_name: z
		.string()
		.min(1)
		.max(64)
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
			"Must be a lowercase slug (a-z, 0-9, hyphens; no leading/trailing hyphens)",
		),
	default_agent: z.string().min(1),
	default_iterations: z.number().int().min(1),
	agents: z.record(z.string(), AgentConfigSchema),
	verification_agent: z.string().optional(),
	testing: TestingConfigSchema.optional(),
	scripts: ScriptsConfigSchema.optional(),
	docs: DocsConfigSchema.optional(),
	review: ReviewConfigSchema.optional(),
	swarm: SwarmConfigSchema.optional(),
});

/**
 * Test result schema
 */
export const TestResultSchema = z.object({
	item: z.string(),
	passed: z.boolean(),
	reason: z.string().optional(),
	details: z.string().optional(),
});

/**
 * Test report schema
 */
export const TestReportSchema = z.object({
	prdName: z.string(),
	timestamp: z.string().datetime(),
	testResults: z.array(TestResultSchema),
	summary: z.object({
		total: z.number().int().min(0),
		passed: z.number().int().min(0),
		failed: z.number().int().min(0),
	}),
	agentOutput: z.string().optional(),
});

/**
 * Test issue schema
 */
export const TestIssueSchema = z.object({
	id: z.string(),
	description: z.string(),
	screenshot: z.string().optional(),
	severity: z.enum(["critical", "major", "minor"]).optional(),
});

/**
 * Dependency info schema
 */
export const DependencyInfoSchema = z.object({
	name: z.string(),
	status: PRDStatusSchema,
	dependencies: z.array(z.string()),
	isComplete: z.boolean(),
	canStart: z.boolean(),
	unmetDependencies: z.array(z.string()),
});

/**
 * PRD summary schema (for list operations)
 */
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
export type AgentConfigZ = z.infer<typeof AgentConfigSchema>;
export type TestingConfigZ = z.infer<typeof TestingConfigSchema>;
export type ScriptsConfigZ = z.infer<typeof ScriptsConfigSchema>;
export type DocsConfigZ = z.infer<typeof DocsConfigSchema>;
export type ReviewConfigZ = z.infer<typeof ReviewConfigSchema>;
export type SwarmConfigZ = z.infer<typeof SwarmConfigSchema>;
export type RalphConfigZ = z.infer<typeof RalphConfigSchema>;
export type TestResultZ = z.infer<typeof TestResultSchema>;
export type TestReportZ = z.infer<typeof TestReportSchema>;
export type TestIssueZ = z.infer<typeof TestIssueSchema>;
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
