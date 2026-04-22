/**
 * Ralph Configuration Loader
 *
 * Loads Ralph configuration from omni.toml using smol-toml.
 * If omni.local.toml exists alongside omni.toml, it overrides the base config.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse } from "smol-toml";
import { validateRalphConfig } from "../schemas.js";
import type {
	RalphConfig,
	ProviderVariantConfig,
	QAConfig,
	QAPlatformConfig,
	ScriptsConfig,
	DocsConfig,
	VerificationConfig,
	ReviewConfig,
	SwarmConfig,
} from "../types.js";
import { type Result, ok, err, ErrorCodes } from "../results.js";

const CONFIG_PATH = "omni.toml";
const LOCAL_CONFIG_PATH = "omni.local.toml";

/**
 * Default provider variant for the per-story verifier when not configured.
 */
export const DEFAULT_STORY_VERIFIER_PROVIDER_VARIANT = "claude-haiku";

/**
 * Raw TOML structure from omni.toml
 */
interface RawTomlConfig {
	ralph?: {
		project_name?: string;
		default_provider_variant?: string;
		default_iterations?: number;
		verification_provider_variant?: string;
		per_story_verification?: boolean;
		provider_variants?: Record<string, RawProviderVariantConfig>;
		verification?: RawVerificationConfig;
		qa?: RawQAConfig;
		scripts?: RawScriptsConfig;
		docs?: RawDocsConfig;
		review?: RawReviewConfig;
		swarm?: RawSwarmConfig;
	};
}

type TomlObject = Record<string, unknown>;

// Re-export path utilities so consumers can use them via config module
export { validateProjectName, getStateDir, getPrdsDir } from "./paths.js";

interface RawProviderVariantConfig {
	command?: string;
	args?: string[];
}

interface RawQAConfig {
	project_verification_instructions?: string;
	qa_iterations?: number;
	instructions?: string;
	health_check_timeout?: number;
	max_health_fix_attempts?: number;
	platforms?: Record<string, RawQAPlatformConfig>;
}

interface RawQAPlatformConfig {
	plugin?: string;
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
	provider_variant?: string;
}

interface RawVerificationConfig {
	story_verifier_provider_variant?: string;
}

interface RawReviewConfig {
	enabled?: boolean;
	provider_variant?: string;
	fix_provider_variant?: string;
	finalize_provider_variant?: string;
	review_provider_variant?: string;
	finalize_enabled?: boolean;
	finalize_prompt?: string;
	first_review_agents?: string[];
	second_review_agents?: string[];
	max_fix_iterations?: number;
	todo_file?: string;
}

interface RawSwarmConfig {
	worktree_parent?: string;
	panes_per_window?: number;
	pane_close_timeout?: number;
	worktree_create_cmd?: string;
	primary_branch?: string;
	merge_provider_variant?: string;
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

	if (ralph.project_name !== undefined) {
		config.project_name = ralph.project_name;
	}
	if (ralph.default_provider_variant) {
		config.default_provider_variant = ralph.default_provider_variant;
	}
	if (ralph.default_iterations !== undefined) {
		config.default_iterations = ralph.default_iterations;
	}
	if (ralph.verification_provider_variant) {
		config.verification_provider_variant = ralph.verification_provider_variant;
	}
	if (ralph.per_story_verification !== undefined) {
		config.per_story_verification = ralph.per_story_verification;
	}

	// Provider variants (required — transformConfig always emits a dict)
	config.provider_variants = {};
	if (ralph.provider_variants) {
		for (const [name, variantRaw] of Object.entries(ralph.provider_variants)) {
			const variant: ProviderVariantConfig = {
				command: variantRaw.command ?? "",
				args: variantRaw.args ?? [],
			};
			config.provider_variants[name] = variant;
		}
	}

	// Verification config
	if (ralph.verification) {
		const verification: VerificationConfig = {};
		if (ralph.verification.story_verifier_provider_variant) {
			verification.story_verifier_provider_variant =
				ralph.verification.story_verifier_provider_variant;
		}
		config.verification = verification;
	}

	// QA config
	if (ralph.qa) {
		const qa: QAConfig = {};
		if (ralph.qa.project_verification_instructions) {
			qa.project_verification_instructions = ralph.qa.project_verification_instructions;
		}
		if (ralph.qa.qa_iterations !== undefined) {
			qa.qa_iterations = ralph.qa.qa_iterations;
		}
		if (ralph.qa.instructions) {
			qa.instructions = ralph.qa.instructions;
		}
		if (ralph.qa.health_check_timeout !== undefined) {
			qa.health_check_timeout = ralph.qa.health_check_timeout;
		}
		if (ralph.qa.max_health_fix_attempts !== undefined) {
			qa.max_health_fix_attempts = ralph.qa.max_health_fix_attempts;
		}
		if (ralph.qa.platforms) {
			const platforms: Record<string, QAPlatformConfig> = {};
			for (const [name, platRaw] of Object.entries(ralph.qa.platforms)) {
				const plat: QAPlatformConfig = {};
				if (platRaw.plugin) plat.plugin = platRaw.plugin;
				platforms[name] = plat;
			}
			qa.platforms = platforms;
		}
		config.qa = qa;
	}

	// Scripts config
	if (ralph.scripts) {
		const scripts: ScriptsConfig = {};
		if (ralph.scripts.setup) scripts.setup = ralph.scripts.setup;
		if (ralph.scripts.start) scripts.start = ralph.scripts.start;
		if (ralph.scripts.health_check) scripts.health_check = ralph.scripts.health_check;
		if (ralph.scripts.teardown) scripts.teardown = ralph.scripts.teardown;
		config.scripts = scripts;
	}

	// Docs config — default to "docs" so doc updates work without explicit config
	const docs: DocsConfig = {
		path: ralph.docs?.path ?? "docs",
	};
	if (ralph.docs?.auto_update !== undefined) {
		docs.auto_update = ralph.docs.auto_update;
	}
	if (ralph.docs?.provider_variant) {
		docs.provider_variant = ralph.docs.provider_variant;
	}
	config.docs = docs;

	// Review config
	if (ralph.review) {
		const review: ReviewConfig = {};
		if (ralph.review.enabled !== undefined) review.enabled = ralph.review.enabled;
		if (ralph.review.provider_variant) review.provider_variant = ralph.review.provider_variant;
		if (ralph.review.fix_provider_variant)
			review.fix_provider_variant = ralph.review.fix_provider_variant;
		if (ralph.review.finalize_provider_variant)
			review.finalize_provider_variant = ralph.review.finalize_provider_variant;
		if (ralph.review.review_provider_variant)
			review.review_provider_variant = ralph.review.review_provider_variant;
		if (ralph.review.finalize_enabled !== undefined)
			review.finalize_enabled = ralph.review.finalize_enabled;
		if (ralph.review.finalize_prompt) review.finalize_prompt = ralph.review.finalize_prompt;
		if (ralph.review.first_review_agents)
			review.first_review_agents = ralph.review.first_review_agents;
		if (ralph.review.second_review_agents)
			review.second_review_agents = ralph.review.second_review_agents;
		if (ralph.review.max_fix_iterations !== undefined)
			review.max_fix_iterations = ralph.review.max_fix_iterations;
		if (ralph.review.todo_file) review.todo_file = ralph.review.todo_file;
		config.review = review;
	}

	// Swarm config
	if (ralph.swarm) {
		const swarm: SwarmConfig = {};
		if (ralph.swarm.worktree_parent) swarm.worktree_parent = ralph.swarm.worktree_parent;
		if (ralph.swarm.panes_per_window !== undefined)
			swarm.panes_per_window = ralph.swarm.panes_per_window;
		if (ralph.swarm.pane_close_timeout !== undefined)
			swarm.pane_close_timeout = ralph.swarm.pane_close_timeout;
		if (ralph.swarm.worktree_create_cmd)
			swarm.worktree_create_cmd = ralph.swarm.worktree_create_cmd;
		if (ralph.swarm.primary_branch) swarm.primary_branch = ralph.swarm.primary_branch;
		if (ralph.swarm.merge_provider_variant)
			swarm.merge_provider_variant = ralph.swarm.merge_provider_variant;
		config.swarm = swarm;
	}

	return config;
}

function isTomlObject(value: unknown): value is TomlObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeTomlObjects(base: TomlObject, override: TomlObject): TomlObject {
	const merged: TomlObject = { ...base };

	for (const [key, overrideValue] of Object.entries(override)) {
		const baseValue = merged[key];
		if (isTomlObject(baseValue) && isTomlObject(overrideValue)) {
			merged[key] = mergeTomlObjects(baseValue, overrideValue);
			continue;
		}

		merged[key] = overrideValue;
	}

	return merged;
}

function getLocalConfigPath(configPath: string): string | null {
	if (basename(configPath) !== CONFIG_PATH) {
		return null;
	}

	return join(dirname(configPath), LOCAL_CONFIG_PATH);
}

async function parseTomlFile(path: string): Promise<RawTomlConfig> {
	try {
		const content = await readFile(path, "utf-8");
		return parse(content) as RawTomlConfig;
	} catch (error) {
		if (error instanceof Error && error.name === "TomlError") {
			throw new Error(`TOML parse error in ${path}: ${error.message}`);
		}

		throw error;
	}
}

/**
 * Validate that every referenced provider variant exists in the config.
 * Names the missing variant and the setting that referenced it.
 */
function validateProviderVariantReferences(config: RalphConfig): Result<RalphConfig> {
	const references: Array<{ name: string | undefined; setting: string }> = [
		{ name: config.default_provider_variant, setting: "ralph.default_provider_variant" },
		{ name: config.verification_provider_variant, setting: "ralph.verification_provider_variant" },
		{
			name: config.verification?.story_verifier_provider_variant,
			setting: "ralph.verification.story_verifier_provider_variant",
		},
		{ name: config.review?.provider_variant, setting: "ralph.review.provider_variant" },
		{ name: config.review?.fix_provider_variant, setting: "ralph.review.fix_provider_variant" },
		{
			name: config.review?.finalize_provider_variant,
			setting: "ralph.review.finalize_provider_variant",
		},
		{
			name: config.review?.review_provider_variant,
			setting: "ralph.review.review_provider_variant",
		},
		{ name: config.docs?.provider_variant, setting: "ralph.docs.provider_variant" },
		{
			name: config.swarm?.merge_provider_variant,
			setting: "ralph.swarm.merge_provider_variant",
		},
	];

	for (const ref of references) {
		if (ref.name && !(ref.name in config.provider_variants)) {
			return err(
				ErrorCodes.CONFIG_INVALID,
				`Provider variant '${ref.name}' referenced by ${ref.setting} is not defined in [ralph.provider_variants.*].`,
			);
		}
	}

	return ok(config);
}

/**
 * Load Ralph configuration from omni.toml, merged with omni.local.toml when present.
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
		const raw = await parseTomlFile(path);
		const localPath = getLocalConfigPath(path);
		const mergedRaw =
			localPath && existsSync(localPath)
				? (mergeTomlObjects(
						raw as TomlObject,
						(await parseTomlFile(localPath)) as TomlObject,
					) as RawTomlConfig)
				: raw;
		const config = transformConfig(mergedRaw);

		const validation = validateRalphConfig(config);
		if (!validation.success) {
			return err(
				ErrorCodes.CONFIG_INVALID,
				`Invalid Ralph configuration: ${validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`,
			);
		}

		return validateProviderVariantReferences(validation.data as RalphConfig);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("TOML parse error in ")) {
			return err(ErrorCodes.CONFIG_INVALID, error.message);
		}
		return err(
			ErrorCodes.UNKNOWN,
			`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Get provider variant configuration by name.
 * Falls back to default_provider_variant when name is omitted.
 */
export function getProviderVariantConfig(
	config: RalphConfig,
	name?: string,
): Result<ProviderVariantConfig> {
	const resolved = name ?? config.default_provider_variant;
	const variant = config.provider_variants[resolved];

	if (!variant) {
		const available = Object.keys(config.provider_variants).join(", ");
		return err(
			ErrorCodes.AGENT_NOT_FOUND,
			`Provider variant '${resolved}' not found. Available: ${available}`,
		);
	}

	return ok(variant);
}

/**
 * Validate that a provider variant exists in the configuration
 */
export function hasProviderVariant(config: RalphConfig, name: string): boolean {
	return name in config.provider_variants;
}

/**
 * Get QA configuration with defaults
 */
export function getQAConfig(config: RalphConfig): QAConfig {
	return {
		qa_iterations: config.qa?.qa_iterations ?? config.default_iterations,
		health_check_timeout: config.qa?.health_check_timeout ?? 30,
		project_verification_instructions: config.qa?.project_verification_instructions,
		instructions: config.qa?.instructions,
		max_health_fix_attempts: config.qa?.max_health_fix_attempts ?? 3,
		platforms: config.qa?.platforms ?? {},
	};
}

/**
 * Get scripts configuration
 */
export function getScriptsConfig(config: RalphConfig): ScriptsConfig {
	return config.scripts ?? {};
}

/**
 * Per-story verification settings with defaults filled in.
 */
export interface StoryVerificationConfig {
	enabled: boolean;
	providerVariantName: string;
}

export function getStoryVerificationConfig(config: RalphConfig): StoryVerificationConfig {
	return {
		enabled: config.per_story_verification ?? true,
		providerVariantName:
			config.verification?.story_verifier_provider_variant ??
			DEFAULT_STORY_VERIFIER_PROVIDER_VARIANT,
	};
}

/**
 * Resolve the provider variant used by the per-story verifier.
 * Falls back to the default variant "claude-haiku" when unconfigured.
 */
export function resolveStoryVerifierProviderVariant(
	config: RalphConfig,
): Result<ProviderVariantConfig> {
	const { providerVariantName } = getStoryVerificationConfig(config);
	return getProviderVariantConfig(config, providerVariantName);
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
		provider_variant: config.review?.provider_variant ?? "",
		fix_provider_variant: config.review?.fix_provider_variant ?? "",
		finalize_provider_variant: config.review?.finalize_provider_variant ?? "",
		review_provider_variant: config.review?.review_provider_variant ?? "",
		finalize_enabled: config.review?.finalize_enabled ?? false,
		finalize_prompt: config.review?.finalize_prompt ?? "",
		first_review_agents: config.review?.first_review_agents ?? DEFAULT_FIRST_REVIEW_AGENTS,
		second_review_agents: config.review?.second_review_agents ?? DEFAULT_SECOND_REVIEW_AGENTS,
		max_fix_iterations: config.review?.max_fix_iterations ?? 3,
		todo_file: config.review?.todo_file ?? "",
	};
}

/**
 * Resolved provider variant configs for each review pipeline phase
 */
export interface ResolvedReviewProviderVariants {
	reviewVariant: ProviderVariantConfig;
	fixVariant: ProviderVariantConfig;
	finalizeVariant: ProviderVariantConfig;
}

/**
 * Resolve per-phase provider variant configs for the review pipeline.
 *
 * Fallback chains:
 * - review:   review.provider_variant → default_provider_variant
 * - fix:      review.fix_provider_variant → review.provider_variant → default_provider_variant
 * - finalize: review.finalize_provider_variant → review.provider_variant → default_provider_variant
 */
export function resolveReviewProviderVariants(
	config: RalphConfig,
	reviewConfig: Required<ReviewConfig>,
): Result<ResolvedReviewProviderVariants> {
	const resolve = (name: string): Result<ProviderVariantConfig> => {
		if (name) return getProviderVariantConfig(config, name);
		return getProviderVariantConfig(config);
	};

	const reviewName = reviewConfig.provider_variant || "";
	const reviewResult = resolve(reviewName);
	if (!reviewResult.ok) {
		return err(reviewResult.error!.code, reviewResult.error!.message);
	}

	const fixName = reviewConfig.fix_provider_variant || reviewConfig.provider_variant || "";
	const fixResult = resolve(fixName);
	if (!fixResult.ok) {
		return err(fixResult.error!.code, fixResult.error!.message);
	}

	const finalizeName =
		reviewConfig.finalize_provider_variant || reviewConfig.provider_variant || "";
	const finalizeResult = resolve(finalizeName);
	if (!finalizeResult.ok) {
		return err(finalizeResult.error!.code, finalizeResult.error!.message);
	}

	return ok({
		reviewVariant: reviewResult.data!,
		fixVariant: fixResult.data!,
		finalizeVariant: finalizeResult.data!,
	});
}

/**
 * Get swarm configuration with defaults filled in
 */
export function getSwarmConfig(
	config: RalphConfig,
): Required<
	Omit<SwarmConfig, "worktree_create_cmd" | "primary_branch" | "merge_provider_variant">
> &
	Pick<SwarmConfig, "worktree_create_cmd" | "primary_branch" | "merge_provider_variant"> {
	return {
		worktree_parent: config.swarm?.worktree_parent ?? "..",
		panes_per_window: config.swarm?.panes_per_window ?? 4,
		pane_close_timeout: config.swarm?.pane_close_timeout ?? 30,
		worktree_create_cmd: config.swarm?.worktree_create_cmd,
		primary_branch: config.swarm?.primary_branch,
		merge_provider_variant: config.swarm?.merge_provider_variant,
	};
}

// Re-export for backward compatibility
export { loadConfig as loadRalphConfig };
