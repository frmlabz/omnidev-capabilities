#!/usr/bin/env bun
/**
 * Ralph Orchestrator Daemon
 *
 * Headless service that exposes ralph/lib functionality via HTTP/WebSocket.
 * Run in the root of a project to manage PRD development.
 *
 * Usage:
 *   ralph-daemon              # Start daemon on localhost with random port
 *   ralph-daemon --bind 0.0.0.0  # Bind to all interfaces (for Tailscale)
 *   ralph-daemon list          # List all registered daemons
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { LogManager } from "./log-buffer.js";
import { ProcessManager } from "./process-manager.js";
import {
	DaemonRegistry,
	listRegistrations,
	pruneStaleRegistrations,
	isDaemonAlive,
	isDaemonStale,
} from "./registry.js";
import { createApp, findAvailablePort, startServer, WebSocketManager } from "./server.js";

const DEFAULT_HOST = "127.0.0.1";

/**
 * Parse command line arguments
 */
function parseCliArgs() {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			bind: {
				type: "string",
				short: "b",
				default: DEFAULT_HOST,
			},
			port: {
				type: "string",
				short: "p",
			},
			help: {
				type: "boolean",
				short: "h",
			},
		},
		allowPositionals: true,
	});

	return {
		command: positionals[0],
		host: values.bind ?? DEFAULT_HOST,
		port: values.port ? Number.parseInt(values.port, 10) : undefined,
		help: values.help,
	};
}

/**
 * Print usage information
 */
function printHelp() {
	console.log(`
Ralph Orchestrator Daemon

Usage:
  ralph-daemon              Start daemon for current project
  ralph-daemon list         List all registered daemons
  ralph-daemon --help       Show this help

Options:
  -b, --bind <host>   Bind address (default: 127.0.0.1)
  -p, --port <port>   Port number (default: random 10000-60000)
  -h, --help          Show help
`);
}

/**
 * List all registered daemons
 */
async function listDaemons() {
	// Prune stale registrations first
	const pruned = await pruneStaleRegistrations();
	if (pruned.length > 0) {
		console.log(`Pruned ${pruned.length} stale registration(s)\n`);
	}

	const registrations = await listRegistrations();

	if (registrations.length === 0) {
		console.log("No daemons registered.");
		return;
	}

	console.log("Registered Daemons:\n");

	for (const reg of registrations) {
		const alive = isDaemonAlive(reg);
		const stale = isDaemonStale(reg);
		const status = !alive ? "DEAD" : stale ? "STALE" : "ALIVE";
		const statusIcon = status === "ALIVE" ? "🟢" : status === "STALE" ? "🟡" : "🔴";

		console.log(`${statusIcon} ${reg.projectName} (${reg.id})`);
		console.log(`   Path: ${reg.projectPath}`);
		console.log(`   URL:  http://${reg.host}:${reg.port}`);
		console.log(`   PID:  ${reg.pid}`);
		console.log(`   Last heartbeat: ${reg.lastHeartbeat}`);
		console.log("");
	}
}

/**
 * Start the daemon
 */
async function startDaemon(host: string, requestedPort?: number) {
	const projectPath = resolve(process.cwd());
	const projectName = projectPath.split("/").pop() ?? "unknown";

	console.log(`Starting Ralph Orchestrator Daemon for: ${projectName}`);
	console.log(`Project path: ${projectPath}\n`);

	// Initialize components
	const registry = new DaemonRegistry();
	const logManager = new LogManager();
	const processManager = new ProcessManager(logManager);
	const wsManager = new WebSocketManager(registry);

	// Find available port
	const port = requestedPort ?? (await findAvailablePort(host));

	// Create and start server
	const app = createApp({
		registry,
		logManager,
		processManager,
		projectPath,
	});

	const server = startServer({
		app,
		wsManager,
		host,
		port,
	});

	// Register daemon
	const registration = await registry.register({
		projectPath,
		projectName,
		host,
		port,
	});

	// Start WebSocket heartbeat
	wsManager.startHeartbeat();

	console.log(`✓ Daemon started`);
	console.log(`  ID:   ${registration.id}`);
	console.log(`  URL:  http://${host}:${port}`);
	console.log(`  PID:  ${process.pid}`);
	console.log(`\nPress Ctrl+C to stop\n`);

	// Graceful shutdown
	const shutdown = async () => {
		console.log("\nShutting down...");

		wsManager.stopHeartbeat();
		await processManager.stopAll();
		await registry.unregister();
		server.stop();

		console.log("Daemon stopped.");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

/**
 * Main entry point
 */
async function main() {
	const args = parseCliArgs();

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	if (args.command === "list") {
		await listDaemons();
		process.exit(0);
	}

	if (args.command && args.command !== "start") {
		console.error(`Unknown command: ${args.command}`);
		printHelp();
		process.exit(1);
	}

	await startDaemon(args.host, args.port);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
