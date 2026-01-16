/**
 * Ralph Capability - AI Agent Orchestrator
 *
 * Provides PRD-driven development through iterative AI agent invocations.
 */

import type { CapabilityExport } from "@omnidev-ai/core";
import { ralphRoutes } from "./cli.js";
import { sync } from "./sync.js";

// Default export: Structured capability export
export default {
	cliCommands: {
		ralph: ralphRoutes,
	},

	gitignore: ["ralph/", "*.ralph.log"],

	sync,
} satisfies CapabilityExport;

export { loadRalphConfig, runAgent, runOrchestration } from "./orchestrator.js";
export { generatePrompt } from "./prompt.js";
// Named exports for programmatic usage
export * from "./state.js";
