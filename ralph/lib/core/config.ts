/**
 * Ralph Configuration Loader
 *
 * Loads Ralph configuration from omni.toml using smol-toml.
 * Replaces the manual TOML parser with proper library support.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { validateRalphConfig } from "../schemas.js";
import type { RalphConfig, AgentConfig, TestingConfig, ScriptsConfig, DocsConfig } from "../types.js";
import { type Result, ok, err, ErrorCodes } from "../results.js";

const CONFIG_PATH = "omni.toml";

/**
 * Raw TOML structure from omni.toml
 */
interface RawTomlConfig {
	ralph?: {
		default_agent?: string;
		default_iterations?: number;
		agents?: Record<string, RawAgentConfig>;
		testing?: RawTestingConfig;
		scripts?: RawScriptsConfig;
		docs?: RawDocsConfig;
	};
}

interface RawAgentConfig {
	command?: string;
	args?: string[];
}

interface RawTestingConfig {
	project_verification_instructions?: string;
	test_iterations?: number;
	web_testing_enabled?: boolean;
	instructions?: string;
	health_check_timeout?: number;
}

interface RawScriptsConfig {
	setup?: string;
	start?: string;
	health_check?: string;
	teardown?: string;
}

interface RawDocsConfig {
	path?: string;
	auto_update?: boolean;
}

/**
 * Transform raw TOML config to RalphConfig structure
 */
function transformConfig(raw: RawTomlConfig): Partial<RalphConfig> {
	const ralph = raw.ralph;
	if (!ralph) {
		return {};
	}

	const config: Partial<RalphConfig> = {};

	// Top-level settings
	if (ralph.default_agent) {
		config.default_agent = ralph.default_agent;
	}
	if (ralph.default_iterations !== undefined) {
		config.default_iterations = ralph.default_iterations;
	}

	// Agents
	if (ralph.agents) {
		config.agents = {};
		for (const [name, agentRaw] of Object.entries(ralph.agents)) {
			const agent: AgentConfig = {
				command: agentRaw.command ?? "",
				args: agentRaw.args ?? [],
			};
			config.agents[name] = agent;
		}
	}

	// Testing config
	if (ralph.testing) {
		const testing: TestingConfig = {};
		if (ralph.testing.project_verification_instructions) {
			testing.project_verification_instructions = ralph.testing.project_verification_instructions;
		}
		if (ralph.testing.test_iterations !== undefined) {
			testing.test_iterations = ralph.testing.test_iterations;
		}
		if (ralph.testing.web_testing_enabled !== undefined) {
			testing.web_testing_enabled = ralph.testing.web_testing_enabled;
		}
		if (ralph.testing.instructions) {
			testing.instructions = ralph.testing.instructions;
		}
		if (ralph.testing.health_check_timeout !== undefined) {
			testing.health_check_timeout = ralph.testing.health_check_timeout;
		}
		config.testing = testing;
	}

	// Scripts config
	if (ralph.scripts) {
		const scripts: ScriptsConfig = {};
		if (ralph.scripts.setup) {
			scripts.setup = ralph.scripts.setup;
		}
		if (ralph.scripts.start) {
			scripts.start = ralph.scripts.start;
		}
		if (ralph.scripts.health_check) {
			scripts.health_check = ralph.scripts.health_check;
		}
		if (ralph.scripts.teardown) {
			scripts.teardown = ralph.scripts.teardown;
		}
		config.scripts = scripts;
	}

	// Docs config
	if (ralph.docs?.path) {
		const docs: DocsConfig = {
			path: ralph.docs.path,
		};
		if (ralph.docs.auto_update !== undefined) {
			docs.auto_update = ralph.docs.auto_update;
		}
		config.docs = docs;
	}

	return config;
}

/**
 * Load Ralph configuration from omni.toml
 */
export async function loadConfig(configPath?: string): Promise<Result<RalphConfig>> {
	const path = configPath ?? CONFIG_PATH;

	if (!existsSync(path)) {
		return err(
			ErrorCodes.CONFIG_NOT_FOUND,
			`Configuration file not found: ${path}. Create omni.toml with a [ralph] section.`,
		);
	}

	try {
		const content = await readFile(path, "utf-8");
		const raw = parse(content) as RawTomlConfig;
		const config = transformConfig(raw);

		// Validate with Zod
		const validation = validateRalphConfig(config);
		if (!validation.success) {
			return err(
				ErrorCodes.CONFIG_INVALID,
				`Invalid Ralph configuration: ${validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`,
			);
		}

		return ok(validation.data as RalphConfig);
	} catch (error) {
		if (error instanceof Error && error.name === "TomlError") {
			return err(ErrorCodes.CONFIG_INVALID, `TOML parse error: ${error.message}`);
		}
		return err(
			ErrorCodes.UNKNOWN,
			`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Get agent configuration by name
 */
export function getAgentConfig(config: RalphConfig, agentName?: string): Result<AgentConfig> {
	const name = agentName ?? config.default_agent;
	const agentConfig = config.agents[name];

	if (!agentConfig) {
		const available = Object.keys(config.agents).join(", ");
		return err(
			ErrorCodes.AGENT_NOT_FOUND,
			`Agent '${name}' not found in configuration. Available agents: ${available}`,
		);
	}

	return ok(agentConfig);
}

/**
 * Validate that an agent exists in the configuration
 */
export function hasAgent(config: RalphConfig, agentName: string): boolean {
	return agentName in config.agents;
}

/**
 * Get testing configuration with defaults
 */
export function getTestingConfig(config: RalphConfig): TestingConfig {
	return {
		test_iterations: config.testing?.test_iterations ?? config.default_iterations,
		health_check_timeout: config.testing?.health_check_timeout ?? 120,
		web_testing_enabled: config.testing?.web_testing_enabled ?? false,
		project_verification_instructions: config.testing?.project_verification_instructions,
		instructions: config.testing?.instructions,
	};
}

/**
 * Get scripts configuration
 */
export function getScriptsConfig(config: RalphConfig): ScriptsConfig {
	return config.scripts ?? {};
}

// Re-export for backward compatibility
export { loadConfig as loadRalphConfig };
