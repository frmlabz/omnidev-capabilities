import assert from "node:assert";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRules, loadSkills } from "@omnidev-ai/core";

describe("Ralph Capability - Skills and Rules Discovery", () => {
	// Get the path to the ralph capability directory from this test file's location
	const ralphPath = dirname(fileURLToPath(import.meta.url));

	it("skills are discovered by loader", async () => {
		const skills = await loadSkills(ralphPath, "ralph");

		assert.ok(skills.length >= 1);

		// Check prd-creation skill
		const prdSkill = skills.find((s) => s.name === "prd");
		assert.ok(prdSkill !== undefined);
		assert.strictEqual(prdSkill?.name, "prd");
		assert.ok(prdSkill?.description?.includes("PRD"));
		assert.ok(prdSkill?.instructions?.includes("PRD Generator"));
		assert.strictEqual(prdSkill?.capabilityId, "ralph");
	});

	it("rules are discovered by loader", async () => {
		const rules = await loadRules(ralphPath, "ralph");

		assert.ok(rules.length >= 2);

		// Check prd-structure rule
		const prdStructureRule = rules.find((r) => r.name === "prd-structure");
		assert.ok(prdStructureRule !== undefined);
		assert.ok(prdStructureRule?.content?.includes("PRD Structure Rules"));
		assert.strictEqual(prdStructureRule?.capabilityId, "ralph");

		// Check iteration-workflow rule
		const workflowRule = rules.find((r) => r.name === "iteration-workflow");
		assert.ok(workflowRule !== undefined);
		assert.ok(workflowRule?.content?.includes("Iteration Workflow Rules"));
		assert.strictEqual(workflowRule?.capabilityId, "ralph");
	});
});
