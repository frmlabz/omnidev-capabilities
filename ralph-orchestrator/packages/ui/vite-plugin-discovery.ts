/**
 * Vite Plugin for Daemon Discovery
 *
 * Adds /api/discover endpoint that reads the daemon registry
 * from ~/.local/state/ralph-orchestrator/daemons/
 */

import type { Plugin } from "vite";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY_DIR = join(homedir(), ".local", "state", "ralph-orchestrator", "daemons");

interface DaemonRegistration {
	schemaVersion: 1;
	id: string;
	projectPath: string;
	projectName: string;
	host: string;
	port: number;
	pid: number;
	startedAt: string;
	lastHeartbeat: string;
}

/**
 * Check if a daemon process is still alive
 */
function isDaemonAlive(registration: DaemonRegistration): boolean {
	try {
		process.kill(registration.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * List all daemon registrations from the registry directory
 */
async function listRegistrations(): Promise<DaemonRegistration[]> {
	try {
		const files = await readdir(REGISTRY_DIR);
		const registrations: DaemonRegistration[] = [];

		for (const file of files) {
			if (file.endsWith(".json")) {
				try {
					const content = await readFile(join(REGISTRY_DIR, file), "utf-8");
					const reg = JSON.parse(content) as DaemonRegistration;
					registrations.push(reg);
				} catch {
					// Skip invalid files
				}
			}
		}

		return registrations;
	} catch {
		return [];
	}
}

export function daemonDiscoveryPlugin(): Plugin {
	return {
		name: "daemon-discovery",
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (req.url !== "/api/discover") {
					return next();
				}

				try {
					const registrations = await listRegistrations();

					// Filter to only alive daemons and transform host if needed
					const daemons = registrations
						.filter((reg) => isDaemonAlive(reg))
						.map((reg) => ({
							...reg,
							// If daemon bound to 0.0.0.0, use the request host for browser connectivity
							host: reg.host === "0.0.0.0" ? req.headers.host?.split(":")[0] || reg.host : reg.host,
						}));

					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ ok: true, daemons }));
				} catch (err) {
					res.statusCode = 500;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ ok: false, error: String(err) }));
				}
			});
		},
	};
}
