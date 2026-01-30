/**
 * HTTP + WebSocket Server
 *
 * Exposes the daemon API and handles real-time WebSocket connections.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { basename, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { DaemonConfig } from "./config.js";
import type { LogManager } from "./log-buffer.js";
import type { ProcessManager } from "./process-manager.js";
import type { DaemonRegistry } from "./registry.js";
import type {
	ApiResponse,
	CommandExecution,
	CommandStatus,
	DaemonInfo,
	WebSocketCommand,
	WebSocketEvent,
	WorktreeSummary,
} from "./types.js";
import { type Worktree, getWorktrees } from "./worktree.js";

// Import ralph lib
import {
	type PRD,
	ensureDirectories,
	findPRDLocation,
	getPRD,
	getPRDSummaries,
	startDevelopment,
	runTests,
	type OrchestratorEvent,
} from "../../../../ralph/lib/index.js";

import type { EnrichedPRDSummary, PRDDisplayState } from "./types.js";

/**
 * Compute display state from PRD status and worktree existence
 */
function computeDisplayState(prdStatus: string, hasWorktree: boolean): PRDDisplayState {
	if (prdStatus === "completed") return "completed";
	if (prdStatus === "testing") return "testing";
	// pending + worktree = in_progress
	if (prdStatus === "pending" && hasWorktree) return "in_progress";
	return "pending";
}

const VERSION = "0.1.0";

/**
 * Strip ANSI escape codes from text for clean log output
 */
function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes contain control chars
	const ansiPattern = /\x1b\[[0-9;]*[a-zA-Z]/g;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes contain control chars
	const oscPattern = /\x1b\].*?\x07/g;
	return text.replace(ansiPattern, "").replace(oscPattern, "");
}

interface WebSocketData {
	subscribedPrds: Set<string>;
	subscribedWorktrees: Set<string>;
}

/**
 * Worktree command manager - tracks running commands per worktree
 */
class WorktreeCommandManager {
	private runningCommands: Map<string, CommandExecution> = new Map();
	private commandLogs: Map<string, string[]> = new Map();

	getRunningCommands(worktreeName: string): string[] {
		const result: string[] = [];
		for (const [id, cmd] of this.runningCommands) {
			if (cmd.worktree === worktreeName && cmd.status === "running") {
				result.push(id);
			}
		}
		return result;
	}

	startCommand(execution: CommandExecution): void {
		this.runningCommands.set(execution.id, execution);
		this.commandLogs.set(execution.id, []);
	}

	appendLog(commandId: string, line: string): void {
		const logs = this.commandLogs.get(commandId);
		if (logs) {
			logs.push(line);
			// Keep only last 1000 lines
			if (logs.length > 1000) {
				logs.shift();
			}
		}
	}

	endCommand(commandId: string, status: CommandStatus, exitCode: number): void {
		const cmd = this.runningCommands.get(commandId);
		if (cmd) {
			cmd.status = status;
			cmd.exitCode = exitCode;
			cmd.endedAt = new Date().toISOString();
		}
	}

	getCommand(commandId: string): CommandExecution | undefined {
		return this.runningCommands.get(commandId);
	}

	getLogs(commandId: string, tail?: number): string[] {
		const logs = this.commandLogs.get(commandId) ?? [];
		if (tail && tail < logs.length) {
			return logs.slice(-tail);
		}
		return logs;
	}

	isCommandRunning(worktreeName: string, commandKey: string): boolean {
		for (const cmd of this.runningCommands.values()) {
			if (
				cmd.worktree === worktreeName &&
				cmd.commandKey === commandKey &&
				cmd.status === "running"
			) {
				return true;
			}
		}
		return false;
	}

	getRunningCommandByKey(worktreeName: string, commandKey: string): CommandExecution | undefined {
		for (const cmd of this.runningCommands.values()) {
			if (
				cmd.worktree === worktreeName &&
				cmd.commandKey === commandKey &&
				cmd.status === "running"
			) {
				return cmd;
			}
		}
		return undefined;
	}
}

/**
 * Create and configure the Hono app
 */
export function createApp(options: {
	registry: DaemonRegistry;
	logManager: LogManager;
	processManager: ProcessManager;
	wsManager: WebSocketManager;
	projectPath: string;
	config: DaemonConfig;
}) {
	const { registry, logManager, processManager, wsManager, projectPath, config } = options;
	const projectName = basename(projectPath);

	const app = new Hono();
	const worktreeCmdManager = new WorktreeCommandManager();

	// Cache worktrees (refresh on request)
	let cachedWorktrees: Worktree[] = [];
	let worktreeCacheTime = 0;
	const WORKTREE_CACHE_TTL = 5000; // 5 seconds

	async function getWorktreesWithCache(): Promise<Worktree[]> {
		const now = Date.now();
		if (now - worktreeCacheTime > WORKTREE_CACHE_TTL) {
			// Get PRD names from main worktree
			const mainPath = join(projectPath, config.mainWorktree);
			const originalCwd = process.cwd();

			try {
				process.chdir(mainPath);
				ensureDirectories();
				const prdSummaries = await getPRDSummaries(true); // Include completed
				const prdNames = prdSummaries.map((p) => p.name);

				cachedWorktrees = await getWorktrees(projectPath, config.mainWorktree, prdNames);
				worktreeCacheTime = now;
			} finally {
				process.chdir(originalCwd);
			}
		}
		return cachedWorktrees;
	}

	// Enable CORS for UI access
	app.use("*", cors());

	// Health check - always responds if alive
	app.get("/api/health", (c) => {
		return c.json({
			ok: true,
			data: { status: "healthy" },
		} satisfies ApiResponse<{ status: string }>);
	});

	// Daemon info
	app.get("/api/info", (c) => {
		const reg = registry.getRegistration();
		const startedAt = reg?.startedAt ? new Date(reg.startedAt).getTime() : Date.now();
		const uptime = Math.floor((Date.now() - startedAt) / 1000);

		return c.json({
			ok: true,
			data: {
				id: registry.getId(),
				projectPath,
				projectName,
				version: VERSION,
				uptime,
			},
		} satisfies ApiResponse<DaemonInfo>);
	});

	// Get daemon config (available commands, etc.)
	app.get("/api/config", (c) => {
		return c.json({
			ok: true,
			data: {
				mainWorktree: config.mainWorktree,
				commands: config.commands,
			},
		} satisfies ApiResponse<{ mainWorktree: string; commands: typeof config.commands }>);
	});

	// ==================== WORKTREE ENDPOINTS ====================

	// List all worktrees
	app.get("/api/worktrees", async (c) => {
		try {
			const worktrees = await getWorktreesWithCache();

			const summaries: WorktreeSummary[] = worktrees.map((wt) => ({
				name: wt.name,
				path: wt.path,
				branch: wt.branch,
				isMain: wt.isMain,
				prdName: wt.prdName,
				runningCommands: worktreeCmdManager.getRunningCommands(wt.name),
			}));

			return c.json({
				ok: true,
				data: summaries,
			} satisfies ApiResponse<WorktreeSummary[]>);
		} catch (err) {
			return c.json(
				{
					ok: false,
					error: {
						code: "WORKTREE_LIST_ERROR",
						message: err instanceof Error ? err.message : "Failed to list worktrees",
					},
				} satisfies ApiResponse<never>,
				500,
			);
		}
	});

	// Get worktree details
	app.get("/api/worktrees/:name", async (c) => {
		const name = c.req.param("name");

		try {
			const worktrees = await getWorktreesWithCache();
			const worktree = worktrees.find((wt) => wt.name === name);

			if (!worktree) {
				return c.json(
					{
						ok: false,
						error: {
							code: "WORKTREE_NOT_FOUND",
							message: `Worktree '${name}' not found`,
						},
					} satisfies ApiResponse<never>,
					404,
				);
			}

			const summary: WorktreeSummary = {
				name: worktree.name,
				path: worktree.path,
				branch: worktree.branch,
				isMain: worktree.isMain,
				prdName: worktree.prdName,
				runningCommands: worktreeCmdManager.getRunningCommands(worktree.name),
			};

			return c.json({
				ok: true,
				data: summary,
			} satisfies ApiResponse<WorktreeSummary>);
		} catch (err) {
			return c.json(
				{
					ok: false,
					error: {
						code: "WORKTREE_GET_ERROR",
						message: err instanceof Error ? err.message : "Failed to get worktree",
					},
				} satisfies ApiResponse<never>,
				500,
			);
		}
	});

	// Get worktree command logs
	app.get("/api/worktrees/:name/logs", (c) => {
		const name = c.req.param("name");
		const commandId = c.req.query("commandId");
		const tailParam = c.req.query("tail");
		const tail = tailParam ? Number.parseInt(tailParam, 10) : undefined;

		if (!commandId) {
			return c.json(
				{
					ok: false,
					error: {
						code: "MISSING_COMMAND_ID",
						message: "commandId query parameter is required",
					},
				} satisfies ApiResponse<never>,
				400,
			);
		}

		const logs = worktreeCmdManager.getLogs(commandId, tail);

		return c.json({
			ok: true,
			data: { logs, worktree: name, commandId },
		} satisfies ApiResponse<{ logs: string[]; worktree: string; commandId: string }>);
	});

	// Run command in worktree
	app.post("/api/worktrees/:name/run", async (c) => {
		const name = c.req.param("name");
		const body = await c.req.json<{ command: string }>();
		const commandKey = body.command;

		// Validate command key
		const commandConfig = config.commands[commandKey];
		if (!commandConfig) {
			return c.json(
				{
					ok: false,
					error: {
						code: "INVALID_COMMAND",
						message: `Unknown command '${commandKey}'. Available: ${Object.keys(config.commands).join(", ")}`,
					},
				} satisfies ApiResponse<never>,
				400,
			);
		}

		// Get worktree
		const worktrees = await getWorktreesWithCache();
		const worktree = worktrees.find((wt) => wt.name === name);

		if (!worktree) {
			return c.json(
				{
					ok: false,
					error: {
						code: "WORKTREE_NOT_FOUND",
						message: `Worktree '${name}' not found`,
					},
				} satisfies ApiResponse<never>,
				404,
			);
		}

		// Check if command is already running
		if (worktreeCmdManager.isCommandRunning(name, commandKey)) {
			return c.json(
				{
					ok: false,
					error: {
						code: "COMMAND_ALREADY_RUNNING",
						message: `Command '${commandKey}' is already running in worktree '${name}'`,
					},
				} satisfies ApiResponse<never>,
				409,
			);
		}

		// Generate command ID
		const commandId = `${name}-${commandKey}-${Date.now()}`;

		// Create execution record
		const execution: CommandExecution = {
			id: commandId,
			worktree: name,
			commandKey,
			label: commandConfig.label,
			command: commandConfig.command,
			status: "running",
			startedAt: new Date().toISOString(),
		};

		worktreeCmdManager.startCommand(execution);

		// Parse command (split by spaces, respecting quotes would be nice but keep simple)
		const cmdParts = commandConfig.command.split(" ");
		const cmd = cmdParts[0] ?? "echo";
		const args = cmdParts.slice(1);

		// Spawn process
		const proc = Bun.spawn([cmd, ...args], {
			cwd: worktree.path,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, FORCE_COLOR: "1" },
		});

		// Broadcast start event
		wsManager.broadcastToWorktree(name, {
			type: "worktree:command:start",
			worktree: name,
			commandId,
			commandKey,
			timestamp: new Date().toISOString(),
		});

		// Stream stdout
		const stdoutReader = proc.stdout.getReader();
		const stderrReader = proc.stderr.getReader();

		const streamOutput = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
			const decoder = new TextDecoder();
			let buffer = "";

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						const cleanLine = stripAnsi(line);
						worktreeCmdManager.appendLog(commandId, cleanLine);
						wsManager.broadcastToWorktree(name, {
							type: "worktree:command:log",
							worktree: name,
							commandId,
							line: cleanLine,
							timestamp: new Date().toISOString(),
						});
					}
				}

				// Flush remaining buffer
				if (buffer) {
					const cleanBuffer = stripAnsi(buffer);
					worktreeCmdManager.appendLog(commandId, cleanBuffer);
					wsManager.broadcastToWorktree(name, {
						type: "worktree:command:log",
						worktree: name,
						commandId,
						line: cleanBuffer,
						timestamp: new Date().toISOString(),
					});
				}
			} catch {
				// Stream closed
			}
		};

		// Stream both stdout and stderr
		Promise.all([streamOutput(stdoutReader), streamOutput(stderrReader)]).then(async () => {
			const exitCode = await proc.exited;
			const status: CommandStatus = exitCode === 0 ? "success" : "failed";

			worktreeCmdManager.endCommand(commandId, status, exitCode);

			wsManager.broadcastToWorktree(name, {
				type: "worktree:command:end",
				worktree: name,
				commandId,
				status,
				exitCode,
				timestamp: new Date().toISOString(),
			});

			// Also broadcast to all for dashboard updates
			wsManager.broadcast({
				type: "worktree:command:end",
				worktree: name,
				commandId,
				status,
				exitCode,
				timestamp: new Date().toISOString(),
			});
		});

		return c.json({
			ok: true,
			data: { commandId, started: true },
		} satisfies ApiResponse<{ commandId: string; started: boolean }>);
	});

	// Stop command in worktree
	app.post("/api/worktrees/:name/stop", async (c) => {
		const name = c.req.param("name");
		const body = await c.req.json<{ command?: string; commandId?: string }>();

		let execution: CommandExecution | undefined;

		if (body.commandId) {
			execution = worktreeCmdManager.getCommand(body.commandId);
		} else if (body.command) {
			execution = worktreeCmdManager.getRunningCommandByKey(name, body.command);
		}

		if (!execution || execution.status !== "running") {
			return c.json(
				{
					ok: false,
					error: {
						code: "NO_RUNNING_COMMAND",
						message: "No matching running command found",
					},
				} satisfies ApiResponse<never>,
				404,
			);
		}

		// TODO: Actually kill the process - need to track process references
		// For now, just mark as failed
		worktreeCmdManager.endCommand(execution.id, "failed", -1);

		wsManager.broadcastToWorktree(name, {
			type: "worktree:command:end",
			worktree: name,
			commandId: execution.id,
			status: "failed",
			exitCode: -1,
			timestamp: new Date().toISOString(),
		});

		return c.json({
			ok: true,
			data: { stopped: true },
		} satisfies ApiResponse<{ stopped: boolean }>);
	});

	// ==================== PRD ENDPOINTS ====================

	// List all PRDs (from main worktree, with worktree info)
	app.get("/api/prds", async (c) => {
		try {
			const worktrees = await getWorktreesWithCache();
			const mainWorktree = worktrees.find((wt) => wt.isMain);

			if (!mainWorktree) {
				return c.json(
					{
						ok: false,
						error: {
							code: "NO_MAIN_WORKTREE",
							message: `Main worktree '${config.mainWorktree}' not found`,
						},
					} satisfies ApiResponse<never>,
					500,
				);
			}

			// Get PRDs from main worktree
			const originalCwd = process.cwd();
			try {
				process.chdir(mainWorktree.path);
				ensureDirectories();
				const summaries = await getPRDSummaries(true); // Include completed

				// Enrich with worktree and running info
				const enrichedSummaries: EnrichedPRDSummary[] = summaries.map((summary) => {
					const matchingWorktree = worktrees.find((wt) => wt.name === summary.name);
					const hasWorktree = matchingWorktree !== undefined;

					return {
						name: summary.name,
						description: summary.description,
						status: summary.status,
						displayState: computeDisplayState(summary.status, hasWorktree),
						storyCount: summary.progress.total,
						completedStories: summary.progress.completed,
						blockedStories: summary.progress.blocked,
						createdAt: summary.startedAt ?? new Date().toISOString(),
						startedAt: summary.startedAt,
						completedAt: summary.completedAt,
						worktree: matchingWorktree?.name ?? null,
						worktreePath: matchingWorktree?.path ?? mainWorktree.path,
						isRunning: processManager.isRunning(summary.name),
						runningOperation: processManager.getProcess(summary.name)?.operation,
					};
				});

				return c.json({
					ok: true,
					data: enrichedSummaries,
				} satisfies ApiResponse<EnrichedPRDSummary[]>);
			} finally {
				process.chdir(originalCwd);
			}
		} catch (err) {
			return c.json(
				{
					ok: false,
					error: {
						code: "PRD_LIST_ERROR",
						message: err instanceof Error ? err.message : "Failed to list PRDs",
					},
				} satisfies ApiResponse<never>,
				500,
			);
		}
	});

	// Get PRD details (from matching worktree if exists, else main)
	app.get("/api/prds/:name", async (c) => {
		const name = c.req.param("name");

		try {
			const worktrees = await getWorktreesWithCache();
			const matchingWorktree = worktrees.find((wt) => wt.name === name);
			const mainWorktree = worktrees.find((wt) => wt.isMain);

			const targetWorktree = matchingWorktree ?? mainWorktree;

			if (!targetWorktree) {
				return c.json(
					{
						ok: false,
						error: {
							code: "NO_MAIN_WORKTREE",
							message: `Main worktree '${config.mainWorktree}' not found`,
						},
					} satisfies ApiResponse<never>,
					500,
				);
			}

			const originalCwd = process.cwd();
			try {
				process.chdir(targetWorktree.path);
				const prd = await getPRD(name);

				return c.json({
					ok: true,
					data: {
						...prd,
						worktree: matchingWorktree?.name ?? null,
						worktreePath: targetWorktree.path,
					},
				} satisfies ApiResponse<PRD & { worktree: string | null; worktreePath: string }>);
			} finally {
				process.chdir(originalCwd);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to get PRD";
			const isNotFound = message.includes("not found");

			return c.json(
				{
					ok: false,
					error: {
						code: isNotFound ? "PRD_NOT_FOUND" : "PRD_GET_ERROR",
						message,
					},
				} satisfies ApiResponse<never>,
				isNotFound ? 404 : 500,
			);
		}
	});

	// Get PRD logs
	app.get("/api/prds/:name/logs", (c) => {
		const name = c.req.param("name");
		const tailParam = c.req.query("tail");
		const tail = tailParam ? Number.parseInt(tailParam, 10) : undefined;

		const logs = logManager.getLogs(name, tail);

		return c.json({
			ok: true,
			data: logs,
		} satisfies ApiResponse<typeof logs>);
	});

	// Start PRD development (creates worktree if needed, then runs agent)
	app.post("/api/prds/:name/start", async (c) => {
		const name = c.req.param("name");

		let worktrees = await getWorktreesWithCache();
		let matchingWorktree = worktrees.find((wt) => wt.name === name);
		const mainWorktree = worktrees.find((wt) => wt.isMain);

		if (!mainWorktree) {
			return c.json(
				{
					ok: false,
					error: {
						code: "NO_MAIN_WORKTREE",
						message: `Main worktree '${config.mainWorktree}' not found`,
					},
				} satisfies ApiResponse<never>,
				500,
			);
		}

		// Check if PRD exists (in main worktree)
		const originalCwd = process.cwd();
		try {
			process.chdir(mainWorktree.path);
			await getPRD(name);
		} catch (err) {
			process.chdir(originalCwd);
			const message = err instanceof Error ? err.message : "Failed to get PRD";
			return c.json(
				{
					ok: false,
					error: {
						code: "PRD_NOT_FOUND",
						message,
					},
				} satisfies ApiResponse<never>,
				404,
			);
		} finally {
			process.chdir(originalCwd);
		}

		// Check if already running
		if (processManager.isRunning(name)) {
			return c.json(
				{
					ok: false,
					error: {
						code: "ALREADY_RUNNING",
						message: `PRD '${name}' is already running`,
					},
				} satisfies ApiResponse<never>,
				409,
			);
		}

		// Create worktree if it doesn't exist
		if (!matchingWorktree) {
			const proc = Bun.spawn(["wt", "switch", "-c", name], {
				cwd: mainWorktree.path,
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;
			const stderr = await new Response(proc.stderr).text();

			if (exitCode !== 0) {
				return c.json(
					{
						ok: false,
						error: {
							code: "WORKTREE_CREATE_FAILED",
							message: stderr || `Failed to create worktree for '${name}'`,
						},
					} satisfies ApiResponse<never>,
					500,
				);
			}

			// Invalidate cache and refetch
			worktreeCacheTime = 0;
			worktrees = await getWorktreesWithCache();
			matchingWorktree = worktrees.find((wt) => wt.name === name);

			wsManager.broadcast({
				type: "worktree:created",
				worktree: name,
				prdName: name,
				timestamp: new Date().toISOString(),
			});
		}

		const targetWorktree = matchingWorktree ?? mainWorktree;

		// Mark as running
		processManager.markRunning(name, "develop");

		wsManager.broadcast({
			type: "prd:status",
			prd: name,
			status: "running",
			timestamp: new Date().toISOString(),
		});

		// Run development using ralph lib directly (async, non-blocking)
		// NOTE: We stay in the main worktree where PRD state is stored
		// The worktree is created for code isolation but PRD operations happen in main
		(async () => {
			const originalCwd = process.cwd();
			try {
				// Stay in main worktree for PRD state
				process.chdir(mainWorktree.path);

				// Helper to log and broadcast
				const logAndBroadcast = (line: string) => {
					const cleanLine = stripAnsi(line);
					logManager.log(name, cleanLine);
					wsManager.broadcastToPrd(name, {
						type: "prd:log",
						prd: name,
						line: cleanLine,
						timestamp: new Date().toISOString(),
					});
				};

				logAndBroadcast(`Starting development for PRD: ${name}`);

				const result = await startDevelopment(name, {
					hasWorktree: true,
					onEvent: (event: OrchestratorEvent) => {
						// Log and stream events
						if (event.type === "log") {
							logAndBroadcast(`[${event.level}] ${event.message}`);
						} else if (event.type === "iteration") {
							logAndBroadcast(`[iteration ${event.current}/${event.max}] Story: ${event.storyId}`);
						} else if (event.type === "state_change") {
							logAndBroadcast(`[state] ${event.from} → ${event.to}`);
						} else if (event.type === "complete") {
							logAndBroadcast(`[complete] ${event.result}: ${event.message}`);
						} else if (event.type === "agent_output") {
							// Stream agent output
							logAndBroadcast(event.data);
						} else if (event.type === "error") {
							logAndBroadcast(`[error] ${event.error}`);
						}
					},
				});

				// Invalidate worktree cache
				worktreeCacheTime = 0;

				// Log result
				if (!result.ok && result.error) {
					logAndBroadcast(`[result] Error: ${result.error.code} - ${result.error.message}`);
				} else if (result.ok && result.data) {
					logAndBroadcast(`[result] ${result.data.outcome}: ${result.data.message}`);
				}

				const status = result.ok ? "completed" : "stopped";
				wsManager.broadcastToPrd(name, {
					type: "prd:status",
					prd: name,
					status,
					timestamp: new Date().toISOString(),
				});
				wsManager.broadcast({
					type: "prd:status",
					prd: name,
					status,
					timestamp: new Date().toISOString(),
				});
			} catch (err) {
				const errorMsg = stripAnsi(`[error] ${err instanceof Error ? err.message : String(err)}`);
				logManager.log(name, errorMsg);
				wsManager.broadcastToPrd(name, {
					type: "prd:log",
					prd: name,
					line: errorMsg,
					timestamp: new Date().toISOString(),
				});
				wsManager.broadcast({
					type: "prd:status",
					prd: name,
					status: "stopped",
					timestamp: new Date().toISOString(),
				});
			} finally {
				process.chdir(originalCwd);
				processManager.markStopped(name);
			}
		})();

		return c.json({
			ok: true,
			data: { started: true, worktree: targetWorktree.name },
		} satisfies ApiResponse<{ started: boolean; worktree: string }>);
	});

	// Stop PRD development
	app.post("/api/prds/:name/stop", async (c) => {
		const name = c.req.param("name");

		const stopped = await processManager.stop(name);

		if (!stopped) {
			return c.json(
				{
					ok: false,
					error: {
						code: "NO_PROCESS",
						message: `No running process for PRD '${name}'`,
					},
				} satisfies ApiResponse<never>,
				404,
			);
		}

		wsManager.broadcast({
			type: "prd:status",
			prd: name,
			status: "stopped",
			timestamp: new Date().toISOString(),
		});

		return c.json({
			ok: true,
			data: { stopped: true },
		} satisfies ApiResponse<{ stopped: boolean }>);
	});

	// Test PRD (in matching worktree)
	app.post("/api/prds/:name/test", async (c) => {
		const name = c.req.param("name");

		const worktrees = await getWorktreesWithCache();
		const matchingWorktree = worktrees.find((wt) => wt.name === name);
		const mainWorktree = worktrees.find((wt) => wt.isMain);

		const targetWorktree = matchingWorktree ?? mainWorktree;

		if (!targetWorktree) {
			return c.json(
				{
					ok: false,
					error: {
						code: "NO_WORKTREE",
						message: `No worktree found for PRD '${name}'`,
					},
				} satisfies ApiResponse<never>,
				404,
			);
		}

		// Check if PRD exists
		const originalCwd = process.cwd();
		try {
			process.chdir(targetWorktree.path);
			await getPRD(name);
		} catch (err) {
			process.chdir(originalCwd);
			const message = err instanceof Error ? err.message : "Failed to get PRD";
			return c.json(
				{
					ok: false,
					error: {
						code: "PRD_NOT_FOUND",
						message,
					},
				} satisfies ApiResponse<never>,
				404,
			);
		} finally {
			process.chdir(originalCwd);
		}

		// Check if already running
		if (processManager.isRunning(name)) {
			return c.json(
				{
					ok: false,
					error: {
						code: "ALREADY_RUNNING",
						message: `PRD '${name}' is already running`,
					},
				} satisfies ApiResponse<never>,
				409,
			);
		}

		// Mark as running
		processManager.markRunning(name, "test");

		wsManager.broadcast({
			type: "prd:status",
			prd: name,
			status: "testing",
			timestamp: new Date().toISOString(),
		});

		// Run tests using ralph lib directly (async, non-blocking)
		// NOTE: We stay in the main worktree where PRD state is stored
		(async () => {
			const originalCwd = process.cwd();
			try {
				// Stay in main worktree for PRD state
				const mainWt = worktrees.find((wt) => wt.isMain);
				process.chdir(mainWt?.path ?? targetWorktree.path);

				// Helper to log and broadcast
				const logAndBroadcast = (line: string) => {
					const cleanLine = stripAnsi(line);
					logManager.log(name, cleanLine);
					wsManager.broadcastToPrd(name, {
						type: "prd:log",
						prd: name,
						line: cleanLine,
						timestamp: new Date().toISOString(),
					});
				};

				logAndBroadcast(`Starting tests for PRD: ${name}`);

				const result = await runTests(name, {
					hasWorktree: matchingWorktree !== undefined,
					onEvent: (event: OrchestratorEvent) => {
						// Log and stream events
						if (event.type === "log") {
							logAndBroadcast(`[${event.level}] ${event.message}`);
						} else if (event.type === "test_complete") {
							logAndBroadcast(
								`[test] Result: ${event.result}${event.issues?.length ? `, Issues: ${event.issues.length}` : ""}`,
							);
						} else if (event.type === "health_check_failed") {
							logAndBroadcast(`[health_check] Failed: ${event.error}`);
						} else if (event.type === "agent_output") {
							logAndBroadcast(event.data);
						} else if (event.type === "error") {
							logAndBroadcast(`[error] ${event.error}`);
						}
					},
				});

				// Invalidate worktree cache
				worktreeCacheTime = 0;

				const status = result.ok ? "completed" : "stopped";
				logAndBroadcast(`[status] ${status}`);
				wsManager.broadcastToPrd(name, {
					type: "prd:status",
					prd: name,
					status,
					timestamp: new Date().toISOString(),
				});
				wsManager.broadcast({
					type: "prd:status",
					prd: name,
					status,
					timestamp: new Date().toISOString(),
				});
			} catch (err) {
				const errorMsg = stripAnsi(`[error] ${err instanceof Error ? err.message : String(err)}`);
				logManager.log(name, errorMsg);
				wsManager.broadcastToPrd(name, {
					type: "prd:log",
					prd: name,
					line: errorMsg,
					timestamp: new Date().toISOString(),
				});
				wsManager.broadcast({
					type: "prd:status",
					prd: name,
					status: "stopped",
					timestamp: new Date().toISOString(),
				});
			} finally {
				process.chdir(originalCwd);
				processManager.markStopped(name);
			}
		})();

		return c.json({
			ok: true,
			data: { started: true, worktree: targetWorktree.name },
		} satisfies ApiResponse<{ started: boolean; worktree: string }>);
	});

	// Create worktree for PRD (wt switch -c <prd-name>)
	app.post("/api/prds/:name/create-worktree", async (c) => {
		const name = c.req.param("name");

		const worktrees = await getWorktreesWithCache();
		const existingWorktree = worktrees.find((wt) => wt.name === name);
		const mainWorktree = worktrees.find((wt) => wt.isMain);

		if (existingWorktree) {
			return c.json(
				{
					ok: false,
					error: {
						code: "WORKTREE_EXISTS",
						message: `Worktree '${name}' already exists`,
					},
				} satisfies ApiResponse<never>,
				409,
			);
		}

		if (!mainWorktree) {
			return c.json(
				{
					ok: false,
					error: {
						code: "NO_MAIN_WORKTREE",
						message: `Main worktree '${config.mainWorktree}' not found`,
					},
				} satisfies ApiResponse<never>,
				500,
			);
		}

		// Run wt switch -c <name> from main worktree
		const proc = Bun.spawn(["wt", "switch", "-c", name], {
			cwd: mainWorktree.path,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		if (exitCode !== 0) {
			return c.json(
				{
					ok: false,
					error: {
						code: "WORKTREE_CREATE_FAILED",
						message: stderr || stdout || `wt switch -c failed with code ${exitCode}`,
					},
				} satisfies ApiResponse<never>,
				500,
			);
		}

		// Invalidate worktree cache
		worktreeCacheTime = 0;

		wsManager.broadcast({
			type: "worktree:created",
			worktree: name,
			prdName: name,
			timestamp: new Date().toISOString(),
		});

		return c.json({
			ok: true,
			data: { created: true, worktree: name },
		} satisfies ApiResponse<{ created: boolean; worktree: string }>);
	});

	// Merge worktree (wt merge)
	app.post("/api/prds/:name/merge", async (c) => {
		const name = c.req.param("name");

		const worktrees = await getWorktreesWithCache();
		const matchingWorktree = worktrees.find((wt) => wt.name === name);

		if (!matchingWorktree) {
			return c.json(
				{
					ok: false,
					error: {
						code: "WORKTREE_NOT_FOUND",
						message: `Worktree '${name}' not found`,
					},
				} satisfies ApiResponse<never>,
				404,
			);
		}

		// Check PRD is completed
		const mainWorktree = worktrees.find((wt) => wt.isMain);
		if (mainWorktree) {
			const originalCwd = process.cwd();
			try {
				process.chdir(matchingWorktree.path);
				const status = findPRDLocation(name);
				if (status !== "completed") {
					return c.json(
						{
							ok: false,
							error: {
								code: "PRD_NOT_COMPLETED",
								message: `PRD '${name}' is not completed (status: ${status})`,
							},
						} satisfies ApiResponse<never>,
						400,
					);
				}
			} finally {
				process.chdir(originalCwd);
			}
		}

		// Run wt merge from the worktree
		const proc = Bun.spawn(["wt", "merge"], {
			cwd: matchingWorktree.path,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		if (exitCode !== 0) {
			return c.json(
				{
					ok: false,
					error: {
						code: "MERGE_FAILED",
						message: stderr || stdout || `wt merge failed with code ${exitCode}`,
					},
				} satisfies ApiResponse<never>,
				500,
			);
		}

		// Invalidate worktree cache
		worktreeCacheTime = 0;

		wsManager.broadcast({
			type: "worktree:merged",
			worktree: name,
			prdName: name,
			timestamp: new Date().toISOString(),
		});

		return c.json({
			ok: true,
			data: { merged: true, worktree: name },
		} satisfies ApiResponse<{ merged: boolean; worktree: string }>);
	});

	return app;
}

/**
 * WebSocket connection manager
 */
export class WebSocketManager {
	private clients: Set<ServerWebSocket<WebSocketData>> = new Set();
	private registry: DaemonRegistry;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	constructor(registry: DaemonRegistry) {
		this.registry = registry;
	}

	/**
	 * Start heartbeat broadcasts
	 */
	startHeartbeat(intervalMs: number = 30_000): void {
		this.heartbeatTimer = setInterval(() => {
			this.broadcast({
				type: "daemon:heartbeat",
				timestamp: new Date().toISOString(),
			});
		}, intervalMs);
	}

	/**
	 * Stop heartbeat broadcasts
	 */
	stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	/**
	 * Handle new WebSocket connection
	 */
	onOpen(ws: ServerWebSocket<WebSocketData>): void {
		this.clients.add(ws);

		const reg = this.registry.getRegistration();
		const event: WebSocketEvent = {
			type: "connected",
			daemonId: this.registry.getId(),
			projectName: reg?.projectName ?? "unknown",
		};

		ws.send(JSON.stringify(event));
	}

	/**
	 * Handle WebSocket message
	 */
	onMessage(ws: ServerWebSocket<WebSocketData>, message: string): void {
		try {
			const cmd = JSON.parse(message) as WebSocketCommand;

			switch (cmd.type) {
				case "subscribe":
					for (const prd of cmd.prds) {
						ws.data.subscribedPrds.add(prd);
					}
					break;

				case "unsubscribe":
					for (const prd of cmd.prds) {
						ws.data.subscribedPrds.delete(prd);
					}
					break;

				case "subscribe:worktree":
					for (const wt of cmd.worktrees) {
						ws.data.subscribedWorktrees.add(wt);
					}
					break;

				case "unsubscribe:worktree":
					for (const wt of cmd.worktrees) {
						ws.data.subscribedWorktrees.delete(wt);
					}
					break;
			}
		} catch {
			// Ignore invalid messages
		}
	}

	/**
	 * Handle WebSocket close
	 */
	onClose(ws: ServerWebSocket<WebSocketData>): void {
		this.clients.delete(ws);
	}

	/**
	 * Broadcast event to all clients
	 */
	broadcast(event: WebSocketEvent): void {
		const message = JSON.stringify(event);
		for (const client of this.clients) {
			try {
				client.send(message);
			} catch {
				// Remove dead clients
				this.clients.delete(client);
			}
		}
	}

	/**
	 * Broadcast event to clients subscribed to a PRD
	 */
	broadcastToPrd(prdName: string, event: WebSocketEvent): void {
		const message = JSON.stringify(event);
		for (const client of this.clients) {
			if (client.data.subscribedPrds.has(prdName)) {
				try {
					client.send(message);
				} catch {
					this.clients.delete(client);
				}
			}
		}
	}

	/**
	 * Broadcast event to clients subscribed to a worktree
	 */
	broadcastToWorktree(worktreeName: string, event: WebSocketEvent): void {
		const message = JSON.stringify(event);
		for (const client of this.clients) {
			if (client.data.subscribedWorktrees.has(worktreeName)) {
				try {
					client.send(message);
				} catch {
					this.clients.delete(client);
				}
			}
		}
	}

	/**
	 * Get connected client count
	 */
	getClientCount(): number {
		return this.clients.size;
	}
}

/**
 * Start the server with HTTP and WebSocket support
 */
export function startServer(options: {
	app: Hono;
	wsManager: WebSocketManager;
	host: string;
	port: number;
}): Server<WebSocketData> {
	const { app, wsManager, host, port } = options;

	const server = Bun.serve<WebSocketData>({
		hostname: host,
		port,
		fetch(req, server) {
			// Handle WebSocket upgrade
			if (req.headers.get("upgrade") === "websocket") {
				const upgraded = server.upgrade(req, {
					data: {
						subscribedPrds: new Set<string>(),
						subscribedWorktrees: new Set<string>(),
					},
				});
				if (upgraded) return undefined;
			}

			// Handle HTTP with Hono
			return app.fetch(req);
		},
		websocket: {
			open(ws) {
				wsManager.onOpen(ws);
			},
			message(ws, message) {
				wsManager.onMessage(ws, String(message));
			},
			close(ws) {
				wsManager.onClose(ws);
			},
		},
	});

	return server;
}

/**
 * Find an available port in the given range
 */
export async function findAvailablePort(
	host: string,
	minPort: number = 10000,
	maxPort: number = 60000,
	maxAttempts: number = 10,
): Promise<number> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const port = Math.floor(Math.random() * (maxPort - minPort + 1)) + minPort;

		try {
			const testServer = Bun.serve({
				hostname: host,
				port,
				fetch: () => new Response("test"),
			});
			testServer.stop();
			return port;
		} catch {
			// Port in use, try another
		}
	}

	throw new Error(`Could not find available port after ${maxAttempts} attempts`);
}
