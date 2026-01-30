/**
 * HTTP + WebSocket Server
 *
 * Exposes the daemon API and handles real-time WebSocket connections.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { basename } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { LogManager } from "./log-buffer.js";
import type { ProcessManager } from "./process-manager.js";
import type { DaemonRegistry } from "./registry.js";
import type { ApiResponse, DaemonInfo, WebSocketCommand, WebSocketEvent } from "./types.js";

// Import ralph lib (uses process.cwd() internally)
import {
	type PRD,
	type PRDSummary,
	ensureDirectories,
	getPRD,
	getPRDSummaries,
} from "../../../../ralph/lib/index.js";

const VERSION = "0.1.0";

interface WebSocketData {
	subscribedPrds: Set<string>;
}

/**
 * Create and configure the Hono app
 */
export function createApp(options: {
	registry: DaemonRegistry;
	logManager: LogManager;
	processManager: ProcessManager;
	projectPath: string;
}) {
	const { registry, logManager, processManager, projectPath } = options;
	const projectName = basename(projectPath);

	const app = new Hono();

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

	// List all PRDs
	app.get("/api/prds", async (c) => {
		try {
			ensureDirectories();
			const summaries = await getPRDSummaries();

			// Add running process info
			const enrichedSummaries = summaries.map((summary) => ({
				...summary,
				isRunning: processManager.isRunning(summary.name),
				runningOperation: processManager.getProcess(summary.name)?.operation,
			}));

			return c.json({
				ok: true,
				data: enrichedSummaries,
			} satisfies ApiResponse<PRDSummary[]>);
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

	// Get PRD details
	app.get("/api/prds/:name", async (c) => {
		const name = c.req.param("name");

		try {
			const prd = await getPRD(name);

			return c.json({
				ok: true,
				data: prd,
			} satisfies ApiResponse<PRD>);
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

	// Start PRD development (placeholder for Phase 3)
	app.post("/api/prds/:name/start", async (c) => {
		const name = c.req.param("name");

		// Phase 1: Just acknowledge the request
		// Phase 3 will implement actual process spawning
		return c.json({
			ok: true,
			data: { message: `Start PRD '${name}' - not yet implemented (Phase 3)` },
		} satisfies ApiResponse<{ message: string }>);
	});

	// Stop PRD development (placeholder for Phase 3)
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

		return c.json({
			ok: true,
			data: { stopped: true },
		} satisfies ApiResponse<{ stopped: boolean }>);
	});

	// Test PRD (placeholder for Phase 3)
	app.post("/api/prds/:name/test", async (c) => {
		const name = c.req.param("name");

		return c.json({
			ok: true,
			data: { message: `Test PRD '${name}' - not yet implemented (Phase 3)` },
		} satisfies ApiResponse<{ message: string }>);
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
					data: { subscribedPrds: new Set<string>() },
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
