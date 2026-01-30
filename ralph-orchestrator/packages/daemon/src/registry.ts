/**
 * Daemon Registry
 *
 * Manages daemon registration in ~/.local/state/ralph-orchestrator/daemons/
 * Handles registration, heartbeat updates, and cleanup on shutdown.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonRegistration } from "./types.js";

const REGISTRY_DIR = join(homedir(), ".local", "state", "ralph-orchestrator", "daemons");
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Generate a short random ID for the daemon
 */
function generateDaemonId(): string {
	return Math.random().toString(36).substring(2, 10);
}

/**
 * Get the registry file path for a daemon ID
 */
function getRegistryPath(daemonId: string): string {
	return join(REGISTRY_DIR, `${daemonId}.json`);
}

/**
 * Ensure the registry directory exists
 */
async function ensureRegistryDir(): Promise<void> {
	await mkdir(REGISTRY_DIR, { recursive: true });
}

/**
 * Read a daemon registration file
 */
export async function readRegistration(daemonId: string): Promise<DaemonRegistration | null> {
	try {
		const content = await readFile(getRegistryPath(daemonId), "utf-8");
		return JSON.parse(content) as DaemonRegistration;
	} catch {
		return null;
	}
}

/**
 * List all registered daemons
 */
export async function listRegistrations(): Promise<DaemonRegistration[]> {
	try {
		await ensureRegistryDir();
		const files = await readdir(REGISTRY_DIR);
		const registrations: DaemonRegistration[] = [];

		for (const file of files) {
			if (file.endsWith(".json")) {
				const daemonId = file.replace(".json", "");
				const reg = await readRegistration(daemonId);
				if (reg) {
					registrations.push(reg);
				}
			}
		}

		return registrations;
	} catch {
		return [];
	}
}

/**
 * Registry manager for a single daemon instance
 */
export class DaemonRegistry {
	private daemonId: string;
	private registration: DaemonRegistration | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.daemonId = generateDaemonId();
	}

	/**
	 * Get the daemon ID
	 */
	getId(): string {
		return this.daemonId;
	}

	/**
	 * Register this daemon
	 */
	async register(options: {
		projectPath: string;
		projectName: string;
		host: string;
		port: number;
	}): Promise<DaemonRegistration> {
		await ensureRegistryDir();

		const now = new Date().toISOString();
		this.registration = {
			schemaVersion: 1,
			id: this.daemonId,
			projectPath: options.projectPath,
			projectName: options.projectName,
			host: options.host,
			port: options.port,
			pid: process.pid,
			startedAt: now,
			lastHeartbeat: now,
		};

		await this.writeRegistration();
		this.startHeartbeat();

		return this.registration;
	}

	/**
	 * Update heartbeat timestamp
	 */
	async heartbeat(): Promise<void> {
		if (!this.registration) return;

		this.registration.lastHeartbeat = new Date().toISOString();
		await this.writeRegistration();
	}

	/**
	 * Unregister this daemon (cleanup)
	 */
	async unregister(): Promise<void> {
		this.stopHeartbeat();

		try {
			await rm(getRegistryPath(this.daemonId));
		} catch {
			// Ignore errors during cleanup
		}

		this.registration = null;
	}

	/**
	 * Get current registration
	 */
	getRegistration(): DaemonRegistration | null {
		return this.registration;
	}

	private async writeRegistration(): Promise<void> {
		if (!this.registration) return;

		await writeFile(getRegistryPath(this.daemonId), JSON.stringify(this.registration, null, 2));
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			this.heartbeat().catch((err) => {
				console.error("Heartbeat failed:", err);
			});
		}, HEARTBEAT_INTERVAL_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}
}

/**
 * Check if a daemon is alive by checking PID and optionally calling health endpoint
 */
export function isDaemonAlive(registration: DaemonRegistration): boolean {
	try {
		// Check if process exists (signal 0 doesn't send anything, just checks)
		process.kill(registration.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a daemon registration is stale (heartbeat > 2 minutes old)
 */
export function isDaemonStale(registration: DaemonRegistration): boolean {
	const lastHeartbeat = new Date(registration.lastHeartbeat).getTime();
	const now = Date.now();
	const twoMinutes = 2 * 60 * 1000;

	return now - lastHeartbeat > twoMinutes;
}

/**
 * Prune stale daemon registrations
 */
export async function pruneStaleRegistrations(): Promise<string[]> {
	const registrations = await listRegistrations();
	const pruned: string[] = [];

	for (const reg of registrations) {
		if (!isDaemonAlive(reg) || isDaemonStale(reg)) {
			try {
				await rm(getRegistryPath(reg.id));
				pruned.push(reg.id);
			} catch {
				// Ignore errors
			}
		}
	}

	return pruned;
}
