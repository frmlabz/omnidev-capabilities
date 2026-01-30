/**
 * Ring Buffer for Log Storage
 *
 * Stores the last N log lines per PRD, automatically evicting old entries.
 * Also writes to files for persistence and easy tailing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LogEntry {
	timestamp: string;
	line: string;
}

/**
 * Ring buffer implementation for log storage
 */
export class LogBuffer {
	private buffer: LogEntry[];
	private head: number = 0;
	private count: number = 0;
	private readonly capacity: number;

	constructor(capacity: number = 1000) {
		this.capacity = capacity;
		this.buffer = new Array(capacity);
	}

	/**
	 * Add a log line to the buffer
	 */
	push(line: string): LogEntry {
		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			line,
		};

		this.buffer[this.head] = entry;
		this.head = (this.head + 1) % this.capacity;

		if (this.count < this.capacity) {
			this.count++;
		}

		return entry;
	}

	/**
	 * Get all log entries in order (oldest first)
	 */
	getAll(): LogEntry[] {
		if (this.count === 0) return [];

		const result: LogEntry[] = [];

		if (this.count < this.capacity) {
			// Buffer not full yet, entries start at 0
			for (let i = 0; i < this.count; i++) {
				const entry = this.buffer[i];
				if (entry) result.push(entry);
			}
		} else {
			// Buffer is full, oldest entry is at head
			for (let i = 0; i < this.capacity; i++) {
				const idx = (this.head + i) % this.capacity;
				const entry = this.buffer[idx];
				if (entry) result.push(entry);
			}
		}

		return result;
	}

	/**
	 * Get the last N entries (newest first)
	 */
	getTail(n: number): LogEntry[] {
		const all = this.getAll();
		return all.slice(-n);
	}

	/**
	 * Get current count of entries
	 */
	size(): number {
		return this.count;
	}

	/**
	 * Clear all entries
	 */
	clear(): void {
		this.buffer = new Array(this.capacity);
		this.head = 0;
		this.count = 0;
	}
}

/**
 * Manages log buffers for multiple PRDs
 * Writes to both memory buffer and files for persistence
 */
export class LogManager {
	private buffers: Map<string, LogBuffer> = new Map();
	private readonly bufferCapacity: number;
	private readonly logsDir: string;

	constructor(projectPath: string, bufferCapacity: number = 1000) {
		this.bufferCapacity = bufferCapacity;
		this.logsDir = join(projectPath, ".omni", "logs");

		// Ensure logs directory exists
		if (!existsSync(this.logsDir)) {
			mkdirSync(this.logsDir, { recursive: true });
		}
	}

	/**
	 * Get log file path for a PRD
	 */
	getLogFilePath(prdName: string): string {
		return join(this.logsDir, `${prdName}.log`);
	}

	/**
	 * Get or create a log buffer for a PRD
	 */
	private getBuffer(prdName: string): LogBuffer {
		let buffer = this.buffers.get(prdName);
		if (!buffer) {
			buffer = new LogBuffer(this.bufferCapacity);
			this.buffers.set(prdName, buffer);
		}
		return buffer;
	}

	/**
	 * Add a log line for a PRD (writes to both memory and file)
	 */
	log(prdName: string, line: string): LogEntry {
		const entry = this.getBuffer(prdName).push(line);

		// Append to file
		const logFile = this.getLogFilePath(prdName);
		const logLine = `${entry.timestamp} ${line}\n`;
		try {
			appendFileSync(logFile, logLine);
		} catch {
			// Ignore write errors
		}

		return entry;
	}

	/**
	 * Get logs for a PRD (from memory buffer)
	 */
	getLogs(prdName: string, tail?: number): LogEntry[] {
		const buffer = this.buffers.get(prdName);
		if (!buffer) {
			// Try to load from file if buffer is empty
			return this.loadLogsFromFile(prdName, tail);
		}

		if (tail !== undefined) {
			return buffer.getTail(tail);
		}
		return buffer.getAll();
	}

	/**
	 * Load logs from file (for when memory buffer is empty)
	 */
	private loadLogsFromFile(prdName: string, tail?: number): LogEntry[] {
		const logFile = this.getLogFilePath(prdName);
		if (!existsSync(logFile)) {
			return [];
		}

		try {
			const content = readFileSync(logFile, "utf-8");
			let lines = content.split("\n").filter((line) => line.trim());

			if (tail !== undefined && lines.length > tail) {
				lines = lines.slice(-tail);
			}

			return lines.map((line) => {
				// Parse timestamp from line (format: "2024-01-30T12:00:00.000Z message")
				const spaceIdx = line.indexOf(" ");
				if (spaceIdx > 0) {
					return {
						timestamp: line.substring(0, spaceIdx),
						line: line.substring(spaceIdx + 1),
					};
				}
				return {
					timestamp: new Date().toISOString(),
					line,
				};
			});
		} catch {
			return [];
		}
	}

	/**
	 * Clear logs for a PRD (both memory and file)
	 */
	clearLogs(prdName: string): void {
		this.buffers.delete(prdName);

		// Clear the file
		const logFile = this.getLogFilePath(prdName);
		try {
			writeFileSync(logFile, "");
		} catch {
			// Ignore
		}
	}

	/**
	 * Get all PRDs with logs
	 */
	getPRDsWithLogs(): string[] {
		return Array.from(this.buffers.keys());
	}
}
