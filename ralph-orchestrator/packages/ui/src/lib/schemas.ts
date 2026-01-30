/**
 * Zod schemas for daemon API responses
 */

import { z } from "zod";

/**
 * PRD Status
 */
export const PRDStatusSchema = z.enum(["pending", "testing", "completed"]);
export type PRDStatus = z.infer<typeof PRDStatusSchema>;

/**
 * Story Status
 */
export const StoryStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked"]);
export type StoryStatus = z.infer<typeof StoryStatusSchema>;

/**
 * Story
 */
export const StorySchema = z.object({
	id: z.string(),
	title: z.string(),
	acceptanceCriteria: z.array(z.string()),
	status: StoryStatusSchema,
	priority: z.number(),
	questions: z.array(z.string()),
	answers: z.array(z.string()).optional(),
	iterationCount: z.number().optional(),
});
export type Story = z.infer<typeof StorySchema>;

/**
 * PRD Metrics
 */
export const PRDMetricsSchema = z.object({
	totalTokens: z.number().optional(),
	inputTokens: z.number().optional(),
	outputTokens: z.number().optional(),
	iterations: z.number().optional(),
});
export type PRDMetrics = z.infer<typeof PRDMetricsSchema>;

/**
 * PRD Summary (list view)
 */
export const PRDSummarySchema = z.object({
	name: z.string(),
	status: PRDStatusSchema,
	description: z.string(),
	progress: z.object({
		completed: z.number(),
		total: z.number(),
		inProgress: z.number(),
		blocked: z.number(),
	}),
	canStart: z.boolean(),
	hasBlockedStories: z.boolean(),
	dependencies: z.array(z.string()),
	unmetDependencies: z.array(z.string()),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	metrics: PRDMetricsSchema.optional(),
	isRunning: z.boolean().optional(),
	runningOperation: z.enum(["develop", "test"]).optional(),
});
export type PRDSummary = z.infer<typeof PRDSummarySchema>;

/**
 * Daemon Info
 */
export const DaemonInfoSchema = z.object({
	id: z.string(),
	projectPath: z.string(),
	projectName: z.string(),
	version: z.string(),
	uptime: z.number(),
});
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

/**
 * Daemon Registration (from registry file)
 */
export const DaemonRegistrationSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string(),
	projectPath: z.string(),
	projectName: z.string(),
	host: z.string(),
	port: z.number(),
	pid: z.number(),
	startedAt: z.string(),
	lastHeartbeat: z.string(),
});
export type DaemonRegistration = z.infer<typeof DaemonRegistrationSchema>;

/**
 * API Response envelope
 */
export const ApiResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
	z.object({
		ok: z.boolean(),
		data: dataSchema.optional(),
		error: z
			.object({
				code: z.string(),
				message: z.string(),
			})
			.optional(),
	});

/**
 * Log Entry
 */
export const LogEntrySchema = z.object({
	timestamp: z.string(),
	line: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;
