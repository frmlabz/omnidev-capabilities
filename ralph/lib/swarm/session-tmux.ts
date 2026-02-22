/**
 * Tmux Session Backend
 *
 * Implements SessionBackend using tmux for session/pane management.
 * Panes are organized into windows with configurable density (default 4 per window).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Result, ok, err } from "../results.js";
import type { SessionBackend, PaneInfo, PaneOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Execute a tmux command and return stdout
 */
async function tmux(...args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("tmux", args, { timeout: 10_000 });
}

/**
 * Execute a tmux command, returning stdout string or an error Result
 */
async function tmuxResult(...args: string[]): Promise<Result<string>> {
	try {
		const { stdout } = await tmux(...args);
		return ok(stdout.trim());
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return err("TMUX_ERROR", msg);
	}
}

export class TmuxSessionBackend implements SessionBackend {
	readonly name = "tmux";

	private panesPerWindow: number;

	constructor(panesPerWindow = 4) {
		this.panesPerWindow = panesPerWindow;
	}

	async isAvailable(): Promise<boolean> {
		try {
			await tmux("has-session", "-t", "__probe_nonexistent__");
			return true;
		} catch (error) {
			// "no server running" means tmux exists but no sessions — still available
			// "command not found" means tmux is not installed
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("command not found") || msg.includes("ENOENT")) {
				return false;
			}
			// Any other error means tmux is installed (e.g., "no session" or "can't find session")
			return true;
		}
	}

	async ensureSession(name: string): Promise<Result<void>> {
		const exists = await this.sessionExists(name);
		if (!exists.ok) return err(exists.error!.code, exists.error!.message);
		if (exists.data) return ok(undefined);

		try {
			await tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50");
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("SESSION_CREATE_FAILED", `Failed to create tmux session "${name}": ${msg}`);
		}
	}

	async sessionExists(name: string): Promise<Result<boolean>> {
		try {
			await tmux("has-session", "-t", name);
			return ok(true);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find session") || msg.includes("no server running")) {
				return ok(false);
			}
			return err("TMUX_ERROR", msg);
		}
	}

	async destroySession(name: string): Promise<Result<void>> {
		try {
			await tmux("kill-session", "-t", name);
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find session")) {
				return ok(undefined); // Already gone
			}
			return err("SESSION_DESTROY_FAILED", msg);
		}
	}

	async createPane(session: string, options: PaneOptions): Promise<Result<PaneInfo>> {
		// Find a window with available slots, or create a new one
		const windowId = options.windowId ?? (await this.findAvailableWindow(session));

		try {
			let paneId: string;

			if (windowId) {
				// Split an existing window
				const result = await tmuxResult(
					"split-window",
					"-t",
					windowId,
					"-P",
					"-F",
					"#{pane_id}",
					...(options.command ? [options.command] : []),
				);
				if (!result.ok) return err(result.error!.code, result.error!.message);
				paneId = result.data!;
			} else {
				// Create a new window in the session
				const result = await tmuxResult(
					"new-window",
					"-t",
					session,
					"-P",
					"-F",
					"#{pane_id}",
					...(options.command ? [options.command] : []),
				);
				if (!result.ok) return err(result.error!.code, result.error!.message);
				paneId = result.data!;
			}

			// Set pane title
			await tmux("select-pane", "-t", paneId, "-T", options.title);

			// Rebalance the window layout
			const targetWindow = paneId.replace(/%\d+$/, "");
			await this.rebalance(session, targetWindow).catch(() => {});

			// Get the window ID for this pane
			const infoResult = await tmuxResult("display-message", "-t", paneId, "-p", "#{window_id}");
			const resolvedWindowId = infoResult.ok && infoResult.data ? infoResult.data : "";

			return ok({
				paneId,
				windowId: resolvedWindowId,
				title: options.title,
				alive: true,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("PANE_CREATE_FAILED", msg);
		}
	}

	async destroyPane(paneId: string): Promise<Result<void>> {
		try {
			await tmux("kill-pane", "-t", paneId);
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find pane")) {
				return ok(undefined); // Already gone
			}
			return err("PANE_DESTROY_FAILED", msg);
		}
	}

	async sendCommand(paneId: string, command: string): Promise<Result<void>> {
		try {
			await tmux("send-keys", "-t", paneId, command, "Enter");
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("SEND_COMMAND_FAILED", msg);
		}
	}

	async sendInterrupt(paneId: string): Promise<Result<void>> {
		try {
			await tmux("send-keys", "-t", paneId, "C-c", "");
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("SEND_INTERRUPT_FAILED", msg);
		}
	}

	async rebalance(session: string, windowId?: string): Promise<Result<void>> {
		const target = windowId ?? session;
		try {
			await tmux("select-layout", "-t", target, "tiled");
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("REBALANCE_FAILED", msg);
		}
	}

	async getPaneCount(session: string, windowId?: string): Promise<Result<number>> {
		try {
			const { stdout } = await tmux("list-panes", "-t", windowId ?? session, "-F", "#{pane_id}");
			const count = stdout.trim().split("\n").filter(Boolean).length;
			return ok(count);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find")) return ok(0);
			return err("TMUX_ERROR", msg);
		}
	}

	async listPanes(session: string): Promise<Result<PaneInfo[]>> {
		try {
			const { stdout } = await tmux(
				"list-panes",
				"-s",
				"-t",
				session,
				"-F",
				"#{pane_id}\t#{window_id}\t#{pane_title}\t#{pane_pid}",
			);

			const panes: PaneInfo[] = stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [paneId, windowId, title, pid] = line.split("\t");
					return {
						paneId: paneId ?? "",
						windowId: windowId ?? "",
						title: title ?? "",
						alive: !!pid && pid !== "0",
					};
				});

			return ok(panes);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find session") || msg.includes("no server running")) {
				return ok([]);
			}
			return err("TMUX_ERROR", msg);
		}
	}

	async isPaneAlive(paneId: string): Promise<Result<boolean>> {
		try {
			const { stdout } = await tmux("display-message", "-t", paneId, "-p", "#{pane_pid}");
			const pid = stdout.trim();
			return ok(!!pid && pid !== "0");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find pane")) {
				return ok(false);
			}
			return err("TMUX_ERROR", msg);
		}
	}

	async focusPane(paneId: string): Promise<Result<void>> {
		try {
			await tmux("select-pane", "-t", paneId);
			await tmux("select-window", "-t", paneId);
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("FOCUS_FAILED", msg);
		}
	}

	/**
	 * Find a window with room for another pane, or return undefined to create a new one.
	 */
	private async findAvailableWindow(session: string): Promise<string | undefined> {
		try {
			const { stdout } = await tmux(
				"list-windows",
				"-t",
				session,
				"-F",
				"#{window_id}\t#{window_panes}",
			);

			for (const line of stdout.trim().split("\n").filter(Boolean)) {
				const [windowId, paneCountStr] = line.split("\t");
				const paneCount = Number.parseInt(paneCountStr ?? "0", 10);
				if (paneCount < this.panesPerWindow) {
					return windowId;
				}
			}

			// All windows full — return undefined to trigger new window creation
			return undefined;
		} catch {
			// Session might be empty — return undefined
			return undefined;
		}
	}
}
