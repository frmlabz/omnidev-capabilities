/**
 * Ralph Event-Based API
 *
 * Provides EventEmitter-based wrappers for orchestration and testing
 * that emit events instead of writing to stdout. Designed for daemon integration.
 *
 * NOTE: This module now wraps the unified OrchestrationEngine from orchestration/engine.ts
 * The EventEmitter interface is maintained for backward compatibility with daemon integration.
 */

import { EventEmitter } from "node:events";
import {
	OrchestrationEngine,
	type EngineEvent,
	type RunOptions as EngineRunOptions,
} from "./orchestration/engine.js";
import { Logger } from "./core/logger.js";
import type { TestReport } from "./types.js";

/**
 * Event types emitted by the orchestrator
 * Re-export from engine for backward compatibility
 */
export type OrchestratorEvent = EngineEvent;

/**
 * Options for running orchestration
 */
export interface OrchestratorOptions {
	/** Override the default agent */
	agent?: string;
	/** Working directory (defaults to cwd) */
	cwd?: string;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
}

/**
 * Orchestrator class that emits events
 * This is a thin wrapper around OrchestrationEngine for backward compatibility
 */
export class Orchestrator extends EventEmitter {
	private engine: OrchestrationEngine;
	private isRunning = false;
	private abortController: AbortController | null = null;

	constructor() {
		super();
		// Create engine with a no-op logger to avoid duplicate console output
		// (events are emitted via onEvent callback instead)
		const silentLogger = new Logger();
		// Don't add any outputs - logs go via events only
		this.engine = new OrchestrationEngine({ logger: silentLogger });
	}

	/**
	 * Emit a typed event
	 */
	private emitEvent(event: OrchestratorEvent): void {
		this.emit("event", event);
		this.emit(event.type, event);
	}

	/**
	 * Run development orchestration for a PRD
	 */
	async runOrchestration(prdName: string, options: OrchestratorOptions = {}): Promise<void> {
		if (this.isRunning) {
			throw new Error("Orchestrator is already running");
		}

		this.isRunning = true;
		this.abortController = new AbortController();

		const signal = options.signal || this.abortController.signal;

		try {
			const engineOptions: EngineRunOptions = {
				agent: options.agent,
				signal,
				onEvent: (event) => this.emitEvent(event),
			};

			const result = await this.engine.runDevelopment(prdName, engineOptions);

			if (!result.ok) {
				this.emitEvent({ type: "error", error: result.error!.message });
				throw new Error(result.error!.message);
			}
		} finally {
			this.isRunning = false;
			this.abortController = null;
		}
	}

	/**
	 * Run testing for a PRD
	 */
	async runTesting(
		prdName: string,
		options: OrchestratorOptions = {},
	): Promise<{ report: TestReport; result: "verified" | "failed" | "unknown" }> {
		if (this.isRunning) {
			throw new Error("Orchestrator is already running");
		}

		this.isRunning = true;
		this.abortController = new AbortController();

		const signal = options.signal || this.abortController.signal;

		try {
			const engineOptions: EngineRunOptions = {
				agent: options.agent,
				signal,
				onEvent: (event) => this.emitEvent(event),
			};

			const result = await this.engine.runTesting(prdName, engineOptions);

			if (!result.ok) {
				this.emitEvent({ type: "error", error: result.error!.message });
				throw new Error(result.error!.message);
			}

			const data = result.data!;
			return {
				report: data.report,
				result:
					data.outcome === "verified"
						? "verified"
						: data.outcome === "failed"
							? "failed"
							: "unknown",
			};
		} finally {
			this.isRunning = false;
			this.abortController = null;
		}
	}

	/**
	 * Stop the current operation
	 */
	stop(): void {
		if (this.abortController) {
			this.abortController.abort();
		}
	}

	/**
	 * Check if running
	 */
	getIsRunning(): boolean {
		return this.isRunning;
	}
}

/**
 * Create a new orchestrator instance
 */
export function createOrchestrator(): Orchestrator {
	return new Orchestrator();
}
