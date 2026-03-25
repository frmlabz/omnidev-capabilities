/**
 * Ralph Capability - AI Agent Orchestrator
 *
 * Provides PRD-driven development through iterative AI agent invocations.
 */

import type { CapabilityExport } from "@omnidev-ai/capability";
import { ralphRoutes } from "./cli.js";
import { sync } from "./sync.js";

// Default export: Structured capability export
export default {
	cliCommands: {
		ralph: ralphRoutes,
	},

	gitignore: ["*.ralph.log"],

	sync,
} satisfies CapabilityExport;

// Re-export everything from lib for programmatic usage
export * from "./lib/index.js";
