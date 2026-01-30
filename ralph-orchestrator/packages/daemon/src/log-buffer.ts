/**
 * Ring Buffer for Log Storage
 *
 * Stores the last N log lines per PRD, automatically evicting old entries.
 */

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
 */
export class LogManager {
	private buffers: Map<string, LogBuffer> = new Map();
	private readonly bufferCapacity: number;

	constructor(bufferCapacity: number = 1000) {
		this.bufferCapacity = bufferCapacity;
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
	 * Add a log line for a PRD
	 */
	log(prdName: string, line: string): LogEntry {
		return this.getBuffer(prdName).push(line);
	}

	/**
	 * Get logs for a PRD
	 */
	getLogs(prdName: string, tail?: number): LogEntry[] {
		const buffer = this.buffers.get(prdName);
		if (!buffer) return [];

		if (tail !== undefined) {
			return buffer.getTail(tail);
		}
		return buffer.getAll();
	}

	/**
	 * Clear logs for a PRD
	 */
	clearLogs(prdName: string): void {
		this.buffers.delete(prdName);
	}

	/**
	 * Get all PRDs with logs
	 */
	getPRDsWithLogs(): string[] {
		return Array.from(this.buffers.keys());
	}
}
