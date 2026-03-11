/**
 * Tmux Session Backend
 *
 * Implements SessionBackend using tmux for session/pane management.
 * Panes are organized into windows with configurable density (default 4 per window).
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { type Result, ok, err } from "../results.js";
import type { SessionBackend, PaneInfo, PaneOptions } from "./types.js";

const execFileAsync = promisify(execFile);
const BOOTSTRAP_PANE_TITLE = "__ralph_swarm_bootstrap__";

type TmuxExecutor = (...args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * Execute a tmux command and return stdout
 */
async function tmux(...args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("tmux", args, { timeout: 10_000 });
}

/**
 * Check if a tmux error indicates no server is running (socket missing or server not started)
 */
function isNoServer(msg: string): boolean {
	return (
		msg.includes("no server running") ||
		(msg.includes("error connecting") && msg.includes("No such file or directory"))
	);
}

export class TmuxSessionBackend implements SessionBackend {
	readonly name = "tmux";

	private panesPerWindow: number;
	private execTmux: TmuxExecutor;

	constructor(panesPerWindow = 4, execTmux: TmuxExecutor = tmux) {
		this.panesPerWindow = panesPerWindow;
		this.execTmux = execTmux;
	}

	private async runTmux(...args: string[]): Promise<{ stdout: string; stderr: string }> {
		return this.execTmux(...args);
	}

	private async runTmuxResult(...args: string[]): Promise<Result<string>> {
		try {
			const { stdout } = await this.runTmux(...args);
			return ok(stdout.trim());
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("TMUX_ERROR", msg);
		}
	}

	async isAvailable(): Promise<boolean> {
		try {
			await this.runTmux("has-session", "-t", "__probe_nonexistent__");
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
			const paneResult = await this.runTmuxResult(
				"new-session",
				"-d",
				"-s",
				name,
				"-x",
				"200",
				"-y",
				"50",
				"-P",
				"-F",
				"#{pane_id}",
			);
			if (!paneResult.ok) return err(paneResult.error!.code, paneResult.error!.message);
			await this.runTmux("select-pane", "-t", paneResult.data!, "-T", BOOTSTRAP_PANE_TITLE);
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("SESSION_CREATE_FAILED", `Failed to create tmux session "${name}": ${msg}`);
		}
	}

	async sessionExists(name: string): Promise<Result<boolean>> {
		try {
			await this.runTmux("has-session", "-t", name);
			return ok(true);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find session") || isNoServer(msg)) {
				return ok(false);
			}
			return err("TMUX_ERROR", msg);
		}
	}

	async destroySession(name: string): Promise<Result<void>> {
		try {
			await this.runTmux("kill-session", "-t", name);
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find session") || isNoServer(msg)) {
				return ok(undefined); // Already gone
			}
			return err("SESSION_DESTROY_FAILED", msg);
		}
	}

	async createPane(session: string, options: PaneOptions): Promise<Result<PaneInfo>> {
		try {
			const bootstrapPane =
				options.windowId === undefined ? await this.findBootstrapPane(session) : undefined;

			let paneId: string;
			let resolvedWindowId = "";

			if (bootstrapPane) {
				paneId = bootstrapPane.paneId;
				resolvedWindowId = bootstrapPane.windowId;
				if (options.command) {
					const sendResult = await this.sendCommand(paneId, options.command);
					if (!sendResult.ok) return err(sendResult.error!.code, sendResult.error!.message);
				}
			} else {
				// Find a window with available slots, or create a new one
				const windowId = options.windowId ?? (await this.findAvailableWindow(session));

				if (windowId) {
					// Split an existing window
					const result = await this.runTmuxResult(
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
					const result = await this.runTmuxResult(
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
			}

			// Set pane title
			await this.runTmux("select-pane", "-t", paneId, "-T", options.title);

			// Rebalance the window layout
			const targetWindow = paneId.replace(/%\d+$/, "");
			await this.rebalance(session, targetWindow).catch(() => {});

			// Get the window ID for this pane
			if (!resolvedWindowId) {
				const infoResult = await this.runTmuxResult(
					"display-message",
					"-t",
					paneId,
					"-p",
					"#{window_id}",
				);
				resolvedWindowId = infoResult.ok && infoResult.data ? infoResult.data : "";
			}

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
			await this.runTmux("kill-pane", "-t", paneId);
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
			await this.runTmux("send-keys", "-t", paneId, command, "Enter");
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("SEND_COMMAND_FAILED", msg);
		}
	}

	async sendInterrupt(paneId: string): Promise<Result<void>> {
		try {
			await this.runTmux("send-keys", "-t", paneId, "C-c", "");
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("SEND_INTERRUPT_FAILED", msg);
		}
	}

	async rebalance(session: string, windowId?: string): Promise<Result<void>> {
		const target = windowId ?? session;
		try {
			await this.runTmux("select-layout", "-t", target, "tiled");
			return ok(undefined);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return err("REBALANCE_FAILED", msg);
		}
	}

	async getPaneCount(session: string, windowId?: string): Promise<Result<number>> {
		try {
			const { stdout } = await this.runTmux(
				"list-panes",
				"-t",
				windowId ?? session,
				"-F",
				"#{pane_id}",
			);
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
			const { stdout } = await this.runTmux(
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
			if (msg.includes("can't find session") || isNoServer(msg)) {
				return ok([]);
			}
			return err("TMUX_ERROR", msg);
		}
	}

	async isPaneAlive(paneId: string): Promise<Result<boolean>> {
		try {
			const { stdout } = await this.runTmux("display-message", "-t", paneId, "-p", "#{pane_pid}");
			const pid = stdout.trim();
			return ok(!!pid && pid !== "0");
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("can't find pane") || isNoServer(msg)) {
				return ok(false);
			}
			return err("TMUX_ERROR", msg);
		}
	}

	async focusPane(paneId: string): Promise<Result<void>> {
		try {
			// Select the target pane/window within the session
			await this.runTmux("select-pane", "-t", paneId);
			await this.runTmux("select-window", "-t", paneId);

			// If we're not inside tmux, attach interactively
			if (!process.env["TMUX"]) {
				const { stdout } = await this.runTmux(
					"display-message",
					"-t",
					paneId,
					"-p",
					"#{session_name}",
				);
				execFileSync("tmux", ["attach-session", "-t", stdout.trim()], {
					stdio: "inherit",
				});
			}

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
			const { stdout } = await this.runTmux(
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

	private async findBootstrapPane(session: string): Promise<PaneInfo | undefined> {
		const panesResult = await this.listPanes(session);
		if (!panesResult.ok) return undefined;

		return panesResult.data?.find((pane) => pane.title === BOOTSTRAP_PANE_TITLE);
	}
}
