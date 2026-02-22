/**
 * Ralph Agent Executor
 *
 * Handles spawning and running agents with proper output parsing.
 * Consolidates agent execution logic from orchestrator.ts and events.ts.
 */

import { spawn } from "node:child_process";
import type { AgentConfig } from "../types.js";
import type { Logger } from "../core/logger.js";

/**
 * Options for running an agent
 */
export interface RunOptions {
	/** Stream output in real-time */
	stream?: boolean;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
	/** Logger for output */
	logger?: Logger;
	/** Callback for agent output chunks */
	onOutput?: (data: string) => void;
	/** Callback for tool usage */
	onTool?: (toolName: string) => void;
}

/**
 * Result of running an agent
 */
export interface AgentResult {
	/** Plain text output (extracted from stream-json if applicable) */
	output: string;
	/** Exit code of the agent process */
	exitCode: number;
	/** Whether the agent was aborted */
	aborted: boolean;
}

/**
 * Context for accumulating stream content
 */
interface StreamContext {
	plainText: string;
}

/**
 * Parse and handle a stream-json line from Claude Code
 */
function handleStreamLine(line: string, ctx: StreamContext, options?: RunOptions): void {
	try {
		const event = JSON.parse(line);

		switch (event.type) {
			case "assistant": {
				const content = event.message?.content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) {
							ctx.plainText += block.text;
							options?.onOutput?.(block.text);
						} else if (block.type === "tool_use") {
							options?.onTool?.(block.name);
						}
					}
				}
				break;
			}
			case "result": {
				if (event.result && typeof event.result === "string") {
					// Use result if plainText is empty
					if (!ctx.plainText.trim()) {
						ctx.plainText = event.result;
					}
				}
				break;
			}
			// Ignore user, system, init events
		}
	} catch {
		// Not JSON - treat as raw output
		if (line.trim()) {
			ctx.plainText += `${line}\n`;
			options?.onOutput?.(`${line}\n`);
		}
	}
}

/**
 * Agent Executor class
 */
export class AgentExecutor {
	/**
	 * Run an agent with the given prompt
	 */
	async run(prompt: string, agentConfig: AgentConfig, options?: RunOptions): Promise<AgentResult> {
		return new Promise((resolve, reject) => {
			const proc = spawn(agentConfig.command, agentConfig.args, {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let lineBuffer = "";
			const streamCtx: StreamContext = { plainText: "" };
			let aborted = false;

			// Handle abort signal
			const abortHandler = () => {
				aborted = true;
				proc.kill("SIGTERM");
			};

			if (options?.signal) {
				options.signal.addEventListener("abort", abortHandler);
			}

			proc.stdout?.on("data", (data) => {
				const chunk = data.toString() as string;
				stdout += chunk;

				if (options?.stream !== false) {
					// Buffer and process complete lines for stream-json format
					lineBuffer += chunk;
					const lines = lineBuffer.split("\n");
					// Keep the last incomplete line in buffer
					lineBuffer = lines.pop() ?? "";

					for (const line of lines) {
						if (line.trim()) {
							handleStreamLine(line, streamCtx, options);
						}
					}
				}
			});

			proc.stderr?.on("data", (data) => {
				const chunk = data.toString() as string;
				stderr += chunk;
				options?.onOutput?.(chunk);
			});

			proc.on("error", (error) => {
				if (options?.signal) {
					options.signal.removeEventListener("abort", abortHandler);
				}
				reject(error);
			});

			proc.on("close", (code) => {
				if (options?.signal) {
					options.signal.removeEventListener("abort", abortHandler);
				}

				// Process any remaining buffered content
				if (options?.stream !== false && lineBuffer.trim()) {
					handleStreamLine(lineBuffer, streamCtx, options);
				}

				// When streaming, return the accumulated plain text for parsing
				// Otherwise return raw stdout/stderr
				const output =
					options?.stream !== false && streamCtx.plainText ? streamCtx.plainText : stdout + stderr;

				resolve({
					output,
					exitCode: code ?? 1,
					aborted,
				});
			});

			// Write prompt to stdin
			if (proc.stdin) {
				proc.stdin.write(prompt);
				proc.stdin.end();
			}
		});
	}

	/**
	 * Parse status from agent output
	 * Returns "completed", "blocked", or null if status cannot be determined
	 */
	parseStatus(output: string, storyId: string): "completed" | "blocked" | null {
		// Look for explicit completion messages
		const completionPatterns = [
			new RegExp(`${storyId}\\s+completed`, "i"),
			new RegExp(`marked\\s+${storyId}\\s+as\\s+completed`, "i"),
			new RegExp(`${storyId}.*status.*completed`, "i"),
			/All checks pass/i,
			/Committed changes/i,
		];

		let completionHints = 0;
		for (const pattern of completionPatterns) {
			if (pattern.test(output)) {
				completionHints++;
			}
		}

		// Look for blocking patterns
		const blockPatterns = [
			new RegExp(`${storyId}.*blocked`, "i"),
			/cannot\s+(complete|proceed)/i,
			/unclear requirements/i,
			/missing.*dependencies/i,
		];

		for (const pattern of blockPatterns) {
			if (pattern.test(output)) {
				return "blocked";
			}
		}

		// If we have multiple completion hints, consider it completed
		if (completionHints >= 2) {
			return "completed";
		}

		// Look for JSON status updates in output
		const jsonMatch = output.match(/\{[^}]*"status"\s*:\s*"(completed|blocked)"[^}]*\}/i);
		if (jsonMatch?.[1]) {
			return jsonMatch[1] as "completed" | "blocked";
		}

		return null;
	}

	/**
	 * Check if output contains completion signal
	 */
	hasCompletionSignal(output: string): boolean {
		return output.includes("<promise>COMPLETE</promise>");
	}

	/**
	 * Parse token usage from Claude Code output
	 */
	parseTokenUsage(output: string): { inputTokens?: number; outputTokens?: number } {
		const inputMatch = output.match(/Input:\s*([\d,]+)/i);
		const outputMatch = output.match(/Output:\s*([\d,]+)/i);

		const result: { inputTokens?: number; outputTokens?: number } = {};

		if (inputMatch?.[1]) {
			result.inputTokens = Number.parseInt(inputMatch[1].replace(/,/g, ""), 10);
		}
		if (outputMatch?.[1]) {
			result.outputTokens = Number.parseInt(outputMatch[1].replace(/,/g, ""), 10);
		}

		return result;
	}
}

// Default executor instance
let defaultExecutor: AgentExecutor | null = null;

/**
 * Get the default agent executor
 */
export function getAgentExecutor(): AgentExecutor {
	if (!defaultExecutor) {
		defaultExecutor = new AgentExecutor();
	}
	return defaultExecutor;
}

/**
 * Create a new agent executor
 */
export function createAgentExecutor(): AgentExecutor {
	return new AgentExecutor();
}
