/**
 * Daemon Configuration
 *
 * Loads config from ralph-orchestrator.yaml in project root.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CommandConfig {
	label: string;
	command: string;
}

export interface DaemonConfig {
	mainWorktree: string;
	commands: Record<string, CommandConfig>;
}

const DEFAULT_CONFIG: DaemonConfig = {
	mainWorktree: "main",
	commands: {
		lint: { label: "Lint", command: "bun run lint" },
		test: { label: "Test", command: "bun run test" },
		typecheck: { label: "Type Check", command: "tsc --noEmit" },
		build: { label: "Build", command: "bun run build" },
	},
};

const CONFIG_FILENAMES = [
	"ralph-orchestrator.yaml",
	"ralph-orchestrator.yml",
	"ralph-orchestrator.json",
];

/**
 * Load configuration from project root
 */
export async function loadConfig(projectRoot: string): Promise<DaemonConfig> {
	for (const filename of CONFIG_FILENAMES) {
		const configPath = join(projectRoot, filename);

		try {
			const content = await readFile(configPath, "utf-8");

			let parsed: Partial<DaemonConfig>;

			if (filename.endsWith(".json")) {
				parsed = JSON.parse(content);
			} else {
				parsed = parseYaml(content);
			}

			// Merge with defaults
			return {
				mainWorktree: parsed.mainWorktree ?? DEFAULT_CONFIG.mainWorktree,
				commands: {
					...DEFAULT_CONFIG.commands,
					...parsed.commands,
				},
			};
		} catch (err) {
			// File doesn't exist or is invalid, continue to next
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`Warning: Failed to parse ${configPath}:`, err);
			}
		}
	}

	// No config file found, use defaults
	return DEFAULT_CONFIG;
}

/**
 * Get the default configuration
 */
export function getDefaultConfig(): DaemonConfig {
	return { ...DEFAULT_CONFIG };
}
