/**
 * Daemon Client
 *
 * HTTP client for communicating with daemons.
 */

import { z } from "zod";
import {
	ApiResponseSchema,
	DaemonConfigSchema,
	DaemonInfoSchema,
	LogEntrySchema,
	PRDSummarySchema,
	WorktreeSummarySchema,
	type DaemonConfig,
	type DaemonInfo,
	type DaemonRegistration,
	type LogEntry,
	type PRDSummary,
	type WorktreeSummary,
} from "./schemas";

/**
 * Daemon with status info (for UI display)
 */
export interface DaemonWithStatus {
	registration: DaemonRegistration;
	healthy: boolean;
	stale: boolean;
	latencyMs?: number;
	info?: DaemonInfo;
	prds: PRDSummary[];
}

/**
 * Check if heartbeat is stale (> 2 minutes old)
 */
function isHeartbeatStale(registration: DaemonRegistration): boolean {
	const lastHeartbeat = new Date(registration.lastHeartbeat).getTime();
	const now = Date.now();
	const twoMinutes = 2 * 60 * 1000;
	return now - lastHeartbeat > twoMinutes;
}

/**
 * Create a daemon client for a specific daemon
 */
export function createDaemonClient(host: string, port: number) {
	const baseUrl = `http://${host}:${port}`;

	async function fetchApi<T>(path: string, schema: z.ZodType<T>): Promise<T> {
		const response = await fetch(`${baseUrl}${path}`);
		const data = await response.json();

		const envelope = ApiResponseSchema(schema).parse(data);

		if (!envelope.ok || !envelope.data) {
			throw new Error(envelope.error?.message ?? "Unknown error");
		}

		return envelope.data;
	}

	return {
		baseUrl,

		/**
		 * Get daemon info
		 */
		async getInfo(): Promise<DaemonInfo> {
			return fetchApi("/api/info", DaemonInfoSchema);
		},

		/**
		 * Get all PRDs
		 */
		async getPRDs(): Promise<PRDSummary[]> {
			return fetchApi("/api/prds", z.array(PRDSummarySchema));
		},

		/**
		 * Get logs for a PRD
		 */
		async getLogs(name: string, tail?: number): Promise<LogEntry[]> {
			const params = tail ? `?tail=${tail}` : "";
			return fetchApi(
				`/api/prds/${encodeURIComponent(name)}/logs${params}`,
				z.array(LogEntrySchema),
			);
		},

		/**
		 * Start PRD development
		 */
		async startPRD(name: string): Promise<{ started: boolean; pid?: number }> {
			const response = await fetch(`${baseUrl}/api/prds/${encodeURIComponent(name)}/start`, {
				method: "POST",
			});
			const data = await response.json();
			const envelope = ApiResponseSchema(
				z.object({ started: z.boolean(), pid: z.number().optional() }),
			).parse(data);

			if (!envelope.ok || !envelope.data) {
				throw new Error(envelope.error?.message ?? "Unknown error");
			}

			return envelope.data;
		},

		/**
		 * Stop PRD development
		 */
		async stopPRD(name: string): Promise<{ stopped: boolean }> {
			const response = await fetch(`${baseUrl}/api/prds/${encodeURIComponent(name)}/stop`, {
				method: "POST",
			});
			const data = await response.json();
			const envelope = ApiResponseSchema(z.object({ stopped: z.boolean() })).parse(data);

			if (!envelope.ok || !envelope.data) {
				throw new Error(envelope.error?.message ?? "Unknown error");
			}

			return envelope.data;
		},

		/**
		 * Test PRD (run tests)
		 */
		async testPRD(name: string): Promise<{ started: boolean; pid?: number }> {
			const response = await fetch(`${baseUrl}/api/prds/${encodeURIComponent(name)}/test`, {
				method: "POST",
			});
			const data = await response.json();
			const envelope = ApiResponseSchema(
				z.object({ started: z.boolean(), pid: z.number().optional() }),
			).parse(data);

			if (!envelope.ok || !envelope.data) {
				throw new Error(envelope.error?.message ?? "Unknown error");
			}

			return envelope.data;
		},

		/**
		 * Merge PRD (merge worktree into main)
		 */
		async mergePRD(name: string): Promise<{ merged: boolean; worktree: string }> {
			const response = await fetch(`${baseUrl}/api/prds/${encodeURIComponent(name)}/merge`, {
				method: "POST",
			});
			const data = await response.json();
			const envelope = ApiResponseSchema(
				z.object({ merged: z.boolean(), worktree: z.string() }),
			).parse(data);

			if (!envelope.ok || !envelope.data) {
				throw new Error(envelope.error?.message ?? "Unknown error");
			}

			return envelope.data;
		},

		/**
		 * Get daemon config
		 */
		async getConfig(): Promise<DaemonConfig> {
			return fetchApi("/api/config", DaemonConfigSchema);
		},

		/**
		 * Get all worktrees
		 */
		async getWorktrees(): Promise<WorktreeSummary[]> {
			return fetchApi("/api/worktrees", z.array(WorktreeSummarySchema));
		},

		/**
		 * Get worktree details
		 */
		async getWorktree(name: string): Promise<WorktreeSummary> {
			return fetchApi(`/api/worktrees/${encodeURIComponent(name)}`, WorktreeSummarySchema);
		},

		/**
		 * Run command in worktree
		 */
		async runCommand(
			worktreeName: string,
			command: string,
		): Promise<{ commandId: string; started: boolean }> {
			const response = await fetch(
				`${baseUrl}/api/worktrees/${encodeURIComponent(worktreeName)}/run`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ command }),
				},
			);
			const data = await response.json();
			const envelope = ApiResponseSchema(
				z.object({ commandId: z.string(), started: z.boolean() }),
			).parse(data);

			if (!envelope.ok || !envelope.data) {
				throw new Error(envelope.error?.message ?? "Unknown error");
			}

			return envelope.data;
		},

		/**
		 * Stop command in worktree
		 */
		async stopCommand(worktreeName: string, commandId: string): Promise<{ stopped: boolean }> {
			const response = await fetch(
				`${baseUrl}/api/worktrees/${encodeURIComponent(worktreeName)}/stop`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ commandId }),
				},
			);
			const data = await response.json();
			const envelope = ApiResponseSchema(z.object({ stopped: z.boolean() })).parse(data);

			if (!envelope.ok || !envelope.data) {
				throw new Error(envelope.error?.message ?? "Unknown error");
			}

			return envelope.data;
		},

		/**
		 * Get command logs
		 */
		async getCommandLogs(
			worktreeName: string,
			commandId: string,
			tail?: number,
		): Promise<{ logs: string[]; worktree: string; commandId: string }> {
			const params = new URLSearchParams({ commandId });
			if (tail) params.set("tail", String(tail));

			return fetchApi(
				`/api/worktrees/${encodeURIComponent(worktreeName)}/logs?${params}`,
				z.object({
					logs: z.array(z.string()),
					worktree: z.string(),
					commandId: z.string(),
				}),
			);
		},
	};
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;

/**
 * Fetch daemon status and PRDs
 */
export async function fetchDaemonStatus(
	registration: DaemonRegistration,
): Promise<DaemonWithStatus> {
	const client = createDaemonClient(registration.host, registration.port);
	const stale = isHeartbeatStale(registration);

	try {
		const start = Date.now();
		const info = await client.getInfo();
		const latencyMs = Date.now() - start;

		const prds = await client.getPRDs();

		return {
			registration,
			healthy: true,
			stale,
			latencyMs,
			info,
			prds,
		};
	} catch {
		return {
			registration,
			healthy: false,
			stale,
			prds: [],
		};
	}
}
