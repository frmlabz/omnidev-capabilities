/**
 * Ralph Logger System
 *
 * Unified logging with multiple output targets.
 * Replaces scattered console.log calls with structured logging.
 */

import { EventEmitter } from "node:events";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Log levels
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Log context - additional structured data
 */
export interface LogContext {
	prdName?: string;
	storyId?: string;
	iteration?: number;
	agentName?: string;
	[key: string]: unknown;
}

/**
 * Log entry
 */
export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	message: string;
	context?: LogContext;
}

/**
 * Log output interface - implement this for custom outputs
 */
export interface LogOutput {
	write(entry: LogEntry): void | Promise<void>;
}

/**
 * Console output - writes to stdout/stderr
 */
export class ConsoleOutput implements LogOutput {
	private colors: boolean;

	constructor(options?: { colors?: boolean }) {
		this.colors = options?.colors ?? process.stdout.isTTY === true;
	}

	write(entry: LogEntry): void {
		const prefix = this.formatPrefix(entry);
		const contextStr = entry.context ? ` ${this.formatContext(entry.context)}` : "";
		const message = `${prefix} ${entry.message}${contextStr}`;

		if (entry.level === "error") {
			console.error(message);
		} else if (entry.level === "warn") {
			console.warn(message);
		} else {
			console.log(message);
		}
	}

	private formatPrefix(entry: LogEntry): string {
		const time = new Date(entry.timestamp).toLocaleTimeString();
		const level = entry.level.toUpperCase().padEnd(5);

		if (!this.colors) {
			return `[${time}] ${level}`;
		}

		const colors: Record<LogLevel, string> = {
			debug: "\x1b[90m", // gray
			info: "\x1b[36m", // cyan
			warn: "\x1b[33m", // yellow
			error: "\x1b[31m", // red
		};
		const reset = "\x1b[0m";

		return `${colors[entry.level]}[${time}] ${level}${reset}`;
	}

	private formatContext(context: LogContext): string {
		const parts: string[] = [];
		if (context.prdName) parts.push(`prd=${context.prdName}`);
		if (context.storyId) parts.push(`story=${context.storyId}`);
		if (context.iteration !== undefined) parts.push(`iter=${context.iteration}`);
		if (context.agentName) parts.push(`agent=${context.agentName}`);

		// Add any other context
		for (const [key, value] of Object.entries(context)) {
			if (!["prdName", "storyId", "iteration", "agentName"].includes(key)) {
				parts.push(`${key}=${JSON.stringify(value)}`);
			}
		}

		return parts.length > 0 ? `[${parts.join(" ")}]` : "";
	}
}

/**
 * File output - writes to a log file
 */
export class FileOutput implements LogOutput {
	private filePath: string;
	private buffer: LogEntry[] = [];
	private flushPromise: Promise<void> | null = null;
	private ensuredDir = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async write(entry: LogEntry): Promise<void> {
		this.buffer.push(entry);
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushPromise) return;

		this.flushPromise = (async () => {
			// Small delay to batch writes
			await new Promise((resolve) => setTimeout(resolve, 100));

			if (this.buffer.length === 0) {
				this.flushPromise = null;
				return;
			}

			const entries = this.buffer;
			this.buffer = [];

			try {
				if (!this.ensuredDir) {
					await mkdir(dirname(this.filePath), { recursive: true });
					this.ensuredDir = true;
				}

				const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
				await appendFile(this.filePath, lines);
			} catch (error) {
				// Silently fail for file logging errors
				console.error(`Failed to write log: ${error}`);
			}

			this.flushPromise = null;
		})();
	}
}

/**
 * Event output - emits log events (for daemon WebSocket)
 */
export class EventOutput extends EventEmitter implements LogOutput {
	write(entry: LogEntry): void {
		this.emit("log", entry);
		this.emit(entry.level, entry);
	}
}

/**
 * Memory output - stores logs in memory (for testing)
 */
export class MemoryOutput implements LogOutput {
	public entries: LogEntry[] = [];
	private maxEntries: number;

	constructor(maxEntries = 1000) {
		this.maxEntries = maxEntries;
	}

	write(entry: LogEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.shift();
		}
	}

	clear(): void {
		this.entries = [];
	}

	getByLevel(level: LogLevel): LogEntry[] {
		return this.entries.filter((e) => e.level === level);
	}
}

/**
 * Logger class - main logging interface
 */
export class Logger {
	private outputs: LogOutput[] = [];
	private minLevel: LogLevel = "info";
	private defaultContext?: LogContext;

	private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3,
	};

	constructor(options?: { minLevel?: LogLevel; context?: LogContext }) {
		this.minLevel = options?.minLevel ?? "info";
		this.defaultContext = options?.context;
	}

	/**
	 * Add an output target
	 */
	addOutput(output: LogOutput): this {
		this.outputs.push(output);
		return this;
	}

	/**
	 * Remove all outputs
	 */
	clearOutputs(): this {
		this.outputs = [];
		return this;
	}

	/**
	 * Set minimum log level
	 */
	setLevel(level: LogLevel): this {
		this.minLevel = level;
		return this;
	}

	/**
	 * Create a child logger with additional context
	 */
	child(context: LogContext): Logger {
		const child = new Logger({
			minLevel: this.minLevel,
			context: { ...this.defaultContext, ...context },
		});
		for (const output of this.outputs) {
			child.addOutput(output);
		}
		return child;
	}

	/**
	 * Log at debug level
	 */
	debug(message: string, context?: LogContext): void {
		this.log("debug", message, context);
	}

	/**
	 * Log at info level
	 */
	info(message: string, context?: LogContext): void {
		this.log("info", message, context);
	}

	/**
	 * Log at warn level
	 */
	warn(message: string, context?: LogContext): void {
		this.log("warn", message, context);
	}

	/**
	 * Log at error level
	 */
	error(message: string, context?: LogContext): void {
		this.log("error", message, context);
	}

	/**
	 * Log at a specific level
	 */
	log(level: LogLevel, message: string, context?: LogContext): void {
		if (Logger.LEVEL_ORDER[level] < Logger.LEVEL_ORDER[this.minLevel]) {
			return;
		}

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			message,
			context: context || this.defaultContext ? { ...this.defaultContext, ...context } : undefined,
		};

		for (const output of this.outputs) {
			try {
				output.write(entry);
			} catch {
				// Silently ignore output errors
			}
		}
	}
}

// Default logger instance
let defaultLogger: Logger | null = null;

/**
 * Get the default logger instance
 */
export function getLogger(): Logger {
	if (!defaultLogger) {
		defaultLogger = new Logger();
		defaultLogger.addOutput(new ConsoleOutput());
	}
	return defaultLogger;
}

/**
 * Configure the default logger
 */
export function configureLogger(options: {
	minLevel?: LogLevel;
	console?: boolean;
	file?: string;
	colors?: boolean;
}): Logger {
	const logger = new Logger({ minLevel: options.minLevel });

	if (options.console !== false) {
		logger.addOutput(new ConsoleOutput({ colors: options.colors }));
	}

	if (options.file) {
		logger.addOutput(new FileOutput(options.file));
	}

	defaultLogger = logger;
	return logger;
}

/**
 * Create a new logger with specific outputs
 */
export function createLogger(options?: {
	minLevel?: LogLevel;
	outputs?: LogOutput[];
	context?: LogContext;
}): Logger {
	const logger = new Logger({
		minLevel: options?.minLevel,
		context: options?.context,
	});

	if (options?.outputs) {
		for (const output of options.outputs) {
			logger.addOutput(output);
		}
	}

	return logger;
}
