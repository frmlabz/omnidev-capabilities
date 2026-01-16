import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules, loadSkills } from "@omnidev-ai/core";

describe("Ralph Capability - Skills and Rules Discovery", () => {
	// Get the path to the ralph capability directory from this test file's location
	const ralphPath = dirname(fileURLToPath(import.meta.url));

	test("skills are discovered by loader", async () => {
		const skills = await loadSkills(ralphPath, "ralph");

		expect(skills.length).toBeGreaterThanOrEqual(2);

		// Check prd-creation skill
		const prdSkill = skills.find((s) => s.name === "prd");
		expect(prdSkill).toBeDefined();
		expect(prdSkill?.name).toBe("prd");
		expect(prdSkill?.description).toContain("PRD");
		expect(prdSkill?.instructions).toContain("PRD Generator");
		expect(prdSkill?.capabilityId).toBe("ralph");

		// Check ralph-orchestration skill
		const ralphSkill = skills.find((s) => s.name === "ralph");
		expect(ralphSkill).toBeDefined();
		expect(ralphSkill?.name).toBe("ralph");
		expect(ralphSkill?.description).toContain("Ralph");
		expect(ralphSkill?.instructions).toContain("Ralph Orchestration Workflow");
		expect(ralphSkill?.capabilityId).toBe("ralph");
	});

	test("rules are discovered by loader", async () => {
		const rules = await loadRules(ralphPath, "ralph");

		expect(rules.length).toBeGreaterThanOrEqual(2);

		// Check prd-structure rule
		const prdStructureRule = rules.find((r) => r.name === "prd-structure");
		expect(prdStructureRule).toBeDefined();
		expect(prdStructureRule?.content).toContain("PRD Structure Rules");
		expect(prdStructureRule?.capabilityId).toBe("ralph");

		// Check iteration-workflow rule
		const workflowRule = rules.find((r) => r.name === "iteration-workflow");
		expect(workflowRule).toBeDefined();
		expect(workflowRule?.content).toContain("Iteration Workflow Rules");
		expect(workflowRule?.capabilityId).toBe("ralph");
	});
});
