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
import type {
	RalphConfig,
	AgentConfig,
	TestingConfig,
	ScriptsConfig,
	DocsConfig,
	ReviewConfig,
	SwarmConfig,
} from "../types.js";
import { type Result, ok, err, ErrorCodes } from "../results.js";

const CONFIG_PATH = "omni.toml";

/**
 * Raw TOML structure from omni.toml
 */
interface RawTomlConfig {
	ralph?: {
		project_name?: string;
		default_agent?: string;
		default_iterations?: number;
		agents?: Record<string, RawAgentConfig>;
		testing?: RawTestingConfig;
		scripts?: RawScriptsConfig;
		docs?: RawDocsConfig;
		review?: RawReviewConfig;
		swarm?: RawSwarmConfig;
	};
}

// Re-export path utilities so consumers can use them via config module
export { validateProjectName, getStateDir, getPrdsDir } from "./paths.js";

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
	max_health_fix_attempts?: number;
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

interface RawReviewConfig {
	enabled?: boolean;
	review_agent?: string;
	finalize_enabled?: boolean;
	finalize_prompt?: string;
	first_review_agents?: string[];
	second_review_agents?: string[];
	max_fix_iterations?: number;
}

interface RawSwarmConfig {
	worktree_parent?: string;
	panes_per_window?: number;
	pane_close_timeout?: number;
	worktree_create_cmd?: string;
	primary_branch?: string;
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
	if (ralph.project_name !== undefined) {
		config.project_name = ralph.project_name;
	}
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
		if (ralph.testing.max_health_fix_attempts !== undefined) {
			testing.max_health_fix_attempts = ralph.testing.max_health_fix_attempts;
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

	// Review config
	if (ralph.review) {
		const review: ReviewConfig = {};
		if (ralph.review.enabled !== undefined) {
			review.enabled = ralph.review.enabled;
		}
		if (ralph.review.review_agent) {
			review.review_agent = ralph.review.review_agent;
		}
		if (ralph.review.finalize_enabled !== undefined) {
			review.finalize_enabled = ralph.review.finalize_enabled;
		}
		if (ralph.review.finalize_prompt) {
			review.finalize_prompt = ralph.review.finalize_prompt;
		}
		if (ralph.review.first_review_agents) {
			review.first_review_agents = ralph.review.first_review_agents;
		}
		if (ralph.review.second_review_agents) {
			review.second_review_agents = ralph.review.second_review_agents;
		}
		if (ralph.review.max_fix_iterations !== undefined) {
			review.max_fix_iterations = ralph.review.max_fix_iterations;
		}
		config.review = review;
	}

	// Swarm config
	if (ralph.swarm) {
		const swarm: SwarmConfig = {};
		if (ralph.swarm.worktree_parent) {
			swarm.worktree_parent = ralph.swarm.worktree_parent;
		}
		if (ralph.swarm.panes_per_window !== undefined) {
			swarm.panes_per_window = ralph.swarm.panes_per_window;
		}
		if (ralph.swarm.pane_close_timeout !== undefined) {
			swarm.pane_close_timeout = ralph.swarm.pane_close_timeout;
		}
		if (ralph.swarm.worktree_create_cmd) {
			swarm.worktree_create_cmd = ralph.swarm.worktree_create_cmd;
		}
		if (ralph.swarm.primary_branch) {
			swarm.primary_branch = ralph.swarm.primary_branch;
		}
		config.swarm = swarm;
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
		health_check_timeout: config.testing?.health_check_timeout ?? 30,
		web_testing_enabled: config.testing?.web_testing_enabled ?? false,
		project_verification_instructions: config.testing?.project_verification_instructions,
		instructions: config.testing?.instructions,
		max_health_fix_attempts: config.testing?.max_health_fix_attempts ?? 3,
	};
}

/**
 * Get scripts configuration
 */
export function getScriptsConfig(config: RalphConfig): ScriptsConfig {
	return config.scripts ?? {};
}

/**
 * Default review agent types for each phase
 */
const DEFAULT_FIRST_REVIEW_AGENTS = [
	"quality",
	"implementation",
	"testing",
	"simplification",
	"documentation",
];
const DEFAULT_SECOND_REVIEW_AGENTS = ["quality", "implementation"];

/**
 * Get review configuration with defaults filled in
 */
export function getReviewConfig(config: RalphConfig): Required<ReviewConfig> {
	return {
		enabled: config.review?.enabled ?? true,
		review_agent: config.review?.review_agent ?? "",
		finalize_enabled: config.review?.finalize_enabled ?? false,
		finalize_prompt: config.review?.finalize_prompt ?? "",
		first_review_agents: config.review?.first_review_agents ?? DEFAULT_FIRST_REVIEW_AGENTS,
		second_review_agents: config.review?.second_review_agents ?? DEFAULT_SECOND_REVIEW_AGENTS,
		max_fix_iterations: config.review?.max_fix_iterations ?? 3,
	};
}

/**
 * Get swarm configuration with defaults filled in
 */
export function getSwarmConfig(
	config: RalphConfig,
): Required<Omit<SwarmConfig, "worktree_create_cmd" | "primary_branch">> &
	Pick<SwarmConfig, "worktree_create_cmd" | "primary_branch"> {
	return {
		worktree_parent: config.swarm?.worktree_parent ?? "..",
		panes_per_window: config.swarm?.panes_per_window ?? 4,
		pane_close_timeout: config.swarm?.pane_close_timeout ?? 30,
		worktree_create_cmd: config.swarm?.worktree_create_cmd,
		primary_branch: config.swarm?.primary_branch,
	};
}

// Re-export for backward compatibility
export { loadConfig as loadRalphConfig };
