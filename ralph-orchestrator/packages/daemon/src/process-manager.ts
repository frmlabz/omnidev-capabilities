/**
 * Process Manager
 *
 * Manages child processes for long-running operations (start PRD, test PRD).
 * Tracks processes by PRD name and allows stopping them.
 */

import type { Subprocess } from "bun";
import type { LogManager } from "./log-buffer.js";

export interface ManagedProcess {
	prdName: string;
	operation: "develop" | "test";
	process: Subprocess;
	startedAt: string;
}

export interface RunningOperation {
	prdName: string;
	operation: "develop" | "test";
	startedAt: string;
}

/**
 * Manages child processes for PRD operations
 */
export class ProcessManager {
	private processes: Map<string, ManagedProcess> = new Map();
	private runningOperations: Map<string, RunningOperation> = new Map();
	private logManager: LogManager;

	constructor(logManager: LogManager) {
		this.logManager = logManager;
	}

	/**
	 * Check if a process or operation is running for a PRD
	 */
	isRunning(prdName: string): boolean {
		// Check lib-based operations first
		if (this.runningOperations.has(prdName)) {
			return true;
		}

		// Check process-based operations
		const managed = this.processes.get(prdName);
		if (!managed) return false;

		// Check if process is still alive
		return !managed.process.killed;
	}

	/**
	 * Get info about a running process
	 */
	getProcess(prdName: string): ManagedProcess | undefined {
		return this.processes.get(prdName);
	}

	/**
	 * Get info about a running operation (lib-based)
	 */
	getOperation(prdName: string): RunningOperation | undefined {
		return this.runningOperations.get(prdName);
	}

	/**
	 * Mark a PRD as running (for lib-based operations)
	 */
	markRunning(prdName: string, operation: "develop" | "test"): void {
		this.runningOperations.set(prdName, {
			prdName,
			operation,
			startedAt: new Date().toISOString(),
		});
	}

	/**
	 * Mark a PRD as stopped (for lib-based operations)
	 */
	markStopped(prdName: string): void {
		this.runningOperations.delete(prdName);
	}

	/**
	 * Start a process for a PRD
	 */
	async start(options: {
		prdName: string;
		operation: "develop" | "test";
		command: string;
		args: string[];
		cwd: string;
		onLog?: (line: string) => void;
		onExit?: (code: number | null) => void;
	}): Promise<ManagedProcess> {
		// Stop existing process if any
		if (this.isRunning(options.prdName)) {
			await this.stop(options.prdName);
		}

		const proc = Bun.spawn([options.command, ...options.args], {
			cwd: options.cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				FORCE_COLOR: "1",
			},
		});

		const managed: ManagedProcess = {
			prdName: options.prdName,
			operation: options.operation,
			process: proc,
			startedAt: new Date().toISOString(),
		};

		this.processes.set(options.prdName, managed);

		// Stream stdout
		if (proc.stdout) {
			this.streamOutput(proc.stdout, options.prdName, options.onLog);
		}

		// Stream stderr
		if (proc.stderr) {
			this.streamOutput(proc.stderr, options.prdName, options.onLog);
		}

		// Handle exit
		proc.exited.then((code) => {
			this.processes.delete(options.prdName);
			options.onExit?.(code);
		});

		return managed;
	}

	/**
	 * Stop a process for a PRD
	 */
	async stop(prdName: string): Promise<boolean> {
		const managed = this.processes.get(prdName);
		if (!managed) return false;

		try {
			managed.process.kill();
			this.processes.delete(prdName);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Stop all processes
	 */
	async stopAll(): Promise<void> {
		const prds = Array.from(this.processes.keys());
		await Promise.all(prds.map((prd) => this.stop(prd)));
	}

	/**
	 * Get all running processes
	 */
	getAll(): ManagedProcess[] {
		return Array.from(this.processes.values()).filter((m) => !m.process.killed);
	}

	private async streamOutput(
		stream: ReadableStream<Uint8Array>,
		prdName: string,
		onLog?: (line: string) => void,
	): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Process complete lines
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.trim()) {
						this.logManager.log(prdName, line);
						onLog?.(line);
					}
				}
			}

			// Process remaining buffer
			if (buffer.trim()) {
				this.logManager.log(prdName, buffer);
				onLog?.(buffer);
			}
		} catch {
			// Stream closed
		}
	}
}
