/**
 * Zod schemas for daemon API responses
 */

import { z } from "zod";

/**
 * PRD Status (from ralph lib)
 */
export const PRDStatusSchema = z.enum(["pending", "testing", "completed"]);
export type PRDStatus = z.infer<typeof PRDStatusSchema>;

/**
 * PRD Display State (computed by daemon)
 * pending = PRD in pending, no worktree
 * in_progress = PRD in pending, has worktree (being developed)
 * testing = PRD in testing
 * completed = PRD completed, ready to merge
 */
export const PRDDisplayStateSchema = z.enum(["pending", "in_progress", "testing", "completed"]);
export type PRDDisplayState = z.infer<typeof PRDDisplayStateSchema>;

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
 * PRD Summary (list view) - enriched by daemon
 */
export const PRDSummarySchema = z.object({
	name: z.string(),
	description: z.string(),
	status: PRDStatusSchema,
	displayState: PRDDisplayStateSchema,
	storyCount: z.number(),
	completedStories: z.number(),
	blockedStories: z.number(),
	createdAt: z.string(),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	worktree: z.string().nullable(),
	worktreePath: z.string(),
	isRunning: z.boolean(),
	runningOperation: z.string().optional(),
});
export type PRDSummary = z.infer<typeof PRDSummarySchema>;

/**
 * Command Status
 */
export const CommandStatusSchema = z.enum(["running", "success", "failed"]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

/**
 * Worktree Summary
 */
export const WorktreeSummarySchema = z.object({
	name: z.string(),
	path: z.string(),
	branch: z.string(),
	isMain: z.boolean(),
	prdName: z.string().nullable(),
	runningCommands: z.array(z.string()),
});
export type WorktreeSummary = z.infer<typeof WorktreeSummarySchema>;

/**
 * Command Config
 */
export const CommandConfigSchema = z.object({
	label: z.string(),
	command: z.string(),
});
export type CommandConfig = z.infer<typeof CommandConfigSchema>;

/**
 * Daemon Config
 */
export const DaemonConfigSchema = z.object({
	mainWorktree: z.string(),
	commands: z.record(z.string(), CommandConfigSchema),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

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
