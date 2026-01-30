/**
 * Daemon Client
 *
 * HTTP client for communicating with daemons.
 */

import { z } from "zod";
import {
	ApiResponseSchema,
	DaemonInfoSchema,
	LogEntrySchema,
	PRDSummarySchema,
	type DaemonInfo,
	type DaemonRegistration,
	type LogEntry,
	type PRDSummary,
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
		async startPRD(name: string): Promise<{ message: string }> {
			const response = await fetch(`${baseUrl}/api/prds/${encodeURIComponent(name)}/start`, {
				method: "POST",
			});
			const data = await response.json();
			const envelope = ApiResponseSchema(z.object({ message: z.string() })).parse(data);

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
