/**
 * Ralph Migrate
 *
 * One-way cutover for legacy PRDs into the Ralph 2.1 layout:
 *   - `prds/testing/` → `prds/qa/`
 *   - `status: "testing"` → `status: "qa"` in prd.json
 *   - `testsCaughtIssue` → `qaCaughtIssue`
 *   - `test-results/` → `qa-results/`
 *   - Stories with legacy `acceptanceCriteria: string[]` → `stories/<id>.md` files
 *     with `## Acceptance Criteria`, and `promptPath` written back onto the story
 *   - Unmigratable PRD directories are moved to `old/` with a migration report
 *
 * Runtime code does not support unmigrated PRDs — this command is the cut.
 */

import { existsSync, readdirSync, renameSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getXdgStateHome, atomicWrite } from "./core/paths.js";

interface LegacyStory {
	id: string;
	title: string;
	promptPath?: string;
	status: string;
	priority: number;
	questions: string[];
	answers?: string[];
	acceptanceCriteria?: string[];
	iterationCount?: number;
	startCommit?: string;
	verificationAttempts?: number;
}

interface LegacyPRD {
	name: string;
	description: string;
	createdAt?: string;
	startedAt?: string;
	completedAt?: string;
	stories: LegacyStory[];
	dependencies?: string[];
	testsCaughtIssue?: boolean;
	qaCaughtIssue?: boolean;
	[key: string]: unknown;
}

export interface MigrationAction {
	kind:
		| "rename_status_dir"
		| "rename_test_results"
		| "rewrite_prd_status"
		| "rewrite_prd_field"
		| "write_story_file"
		| "strip_acceptance_criteria"
		| "quarantine_prd"
		| "noop";
	project: string;
	path: string;
	detail?: string;
}

export interface MigrationReport {
	stateRoot: string;
	projects: string[];
	actions: MigrationAction[];
	warnings: string[];
	quarantined: Array<{
		project: string;
		prdName: string;
		from: string;
		to: string;
		reason: string;
	}>;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function safeReaddir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function formatStoryMarkdown(story: LegacyStory): string {
	const criteria = (story.acceptanceCriteria ?? []).map((c) => `- [ ] ${c}`).join("\n");
	const priority = typeof story.priority === "number" ? story.priority : 1;

	return [
		"---",
		`id: ${story.id}`,
		`title: ${story.title}`,
		`priority: ${priority}`,
		"dependencies: []",
		"---",
		"",
		"## Goal",
		story.title,
		"",
		"## Scope",
		"- (migrated from legacy prd.json — edit as needed)",
		"",
		"## Out of scope",
		"- (none declared)",
		"",
		"## Deliverables",
		"1. Satisfy every item in Acceptance Criteria",
		"",
		"## Acceptance Criteria",
		criteria.length > 0
			? criteria
			: "- [ ] (no criteria recorded in legacy prd.json — fill in before running)",
		"",
	].join("\n");
}

async function migrateStatusDirs(
	projectName: string,
	projectDir: string,
	report: MigrationReport,
): Promise<void> {
	const prdsDir = join(projectDir, "prds");
	if (!isDir(prdsDir)) return;

	const testingDir = join(prdsDir, "testing");
	const qaDir = join(prdsDir, "qa");
	if (isDir(testingDir)) {
		if (isDir(qaDir)) {
			report.warnings.push(
				`${projectName}: both prds/testing and prds/qa exist — merging testing/* into qa/`,
			);
			for (const entry of safeReaddir(testingDir)) {
				const from = join(testingDir, entry);
				const to = join(qaDir, entry);
				if (existsSync(to)) {
					report.warnings.push(
						`${projectName}: ${entry} exists in both prds/testing and prds/qa — left in testing/ untouched`,
					);
					continue;
				}
				renameSync(from, to);
				report.actions.push({
					kind: "rename_status_dir",
					project: projectName,
					path: `prds/testing/${entry} → prds/qa/${entry}`,
				});
			}
			// Attempt to remove testing/ if empty
			if (safeReaddir(testingDir).length === 0) {
				renameSync(testingDir, join(prdsDir, ".testing-empty-stub"));
				// Best-effort remove
				try {
					const { rmSync } = await import("node:fs");
					rmSync(join(prdsDir, ".testing-empty-stub"), { recursive: true });
				} catch {
					// ignore
				}
			}
		} else {
			renameSync(testingDir, qaDir);
			report.actions.push({
				kind: "rename_status_dir",
				project: projectName,
				path: "prds/testing → prds/qa",
			});
		}
	}
}

async function migratePRDJson(
	projectName: string,
	prdDir: string,
	prdName: string,
	report: MigrationReport,
): Promise<void> {
	const prdJsonPath = join(prdDir, "prd.json");
	if (!existsSync(prdJsonPath)) return;

	let prd: LegacyPRD;
	try {
		const raw = await readFile(prdJsonPath, "utf-8");
		prd = JSON.parse(raw) as LegacyPRD;
	} catch (err) {
		report.warnings.push(`${projectName}/${prdName}: failed to parse prd.json — ${err}`);
		return;
	}

	let changed = false;

	if ((prd as { status?: string }).status === "testing") {
		(prd as { status?: string }).status = "qa";
		changed = true;
		report.actions.push({
			kind: "rewrite_prd_status",
			project: projectName,
			path: `${prdName}/prd.json`,
			detail: 'status "testing" → "qa"',
		});
	}

	if (Object.prototype.hasOwnProperty.call(prd, "testsCaughtIssue")) {
		const value = prd.testsCaughtIssue;
		delete prd.testsCaughtIssue;
		if (!Object.prototype.hasOwnProperty.call(prd, "qaCaughtIssue")) {
			prd.qaCaughtIssue = value;
		}
		changed = true;
		report.actions.push({
			kind: "rewrite_prd_field",
			project: projectName,
			path: `${prdName}/prd.json`,
			detail: "testsCaughtIssue → qaCaughtIssue",
		});
	}

	const storiesDir = join(prdDir, "stories");
	for (const story of prd.stories ?? []) {
		const legacyAC = story.acceptanceCriteria;
		const hasLegacyAC = Array.isArray(legacyAC);

		if (!story.promptPath) {
			story.promptPath = `stories/${story.id}.md`;
			changed = true;
		}

		const storyFileAbs = join(prdDir, story.promptPath);

		if (!existsSync(storyFileAbs)) {
			mkdirSync(storiesDir, { recursive: true });
			const markdown = formatStoryMarkdown(story);
			await writeFile(storyFileAbs, markdown);
			report.actions.push({
				kind: "write_story_file",
				project: projectName,
				path: `${prdName}/${story.promptPath}`,
				detail: hasLegacyAC
					? `${legacyAC!.length} acceptance criteria migrated`
					: "no legacy AC — stub written",
			});
			changed = true;
		}

		if (hasLegacyAC) {
			delete story.acceptanceCriteria;
			changed = true;
			report.actions.push({
				kind: "strip_acceptance_criteria",
				project: projectName,
				path: `${prdName}/prd.json`,
				detail: `${story.id}: removed acceptanceCriteria[] (lives in ${story.promptPath})`,
			});
		}
	}

	if (changed) {
		await atomicWrite(prdJsonPath, JSON.stringify(prd, null, 2));
	}
}

async function migrateTestResultsDir(
	projectName: string,
	prdDir: string,
	prdName: string,
	report: MigrationReport,
): Promise<void> {
	const testResults = join(prdDir, "test-results");
	const qaResults = join(prdDir, "qa-results");
	if (!isDir(testResults)) return;

	if (isDir(qaResults)) {
		report.warnings.push(
			`${projectName}/${prdName}: both test-results/ and qa-results/ exist — left both in place`,
		);
		return;
	}

	renameSync(testResults, qaResults);
	report.actions.push({
		kind: "rename_test_results",
		project: projectName,
		path: `${prdName}: test-results/ → qa-results/`,
	});
}

async function quarantinePRD(
	projectName: string,
	projectDir: string,
	prdDir: string,
	prdName: string,
	status: string,
	reason: string,
	report: MigrationReport,
): Promise<void> {
	const oldDir = join(projectDir, "old");
	mkdirSync(oldDir, { recursive: true });
	const dest = join(oldDir, `${status}-${prdName}`);
	renameSync(prdDir, dest);

	const reportPath = join(dest, "MIGRATION-REPORT.md");
	const body = `# Migration Report: ${prdName}

This PRD was quarantined during \`ralph migrate\` and moved out of the active
Ralph state tree.

- Project: ${projectName}
- Source status folder: prds/${status}/
- Moved to: old/${status}-${prdName}/
- Reason: ${reason}

Runtime Ralph commands will not see this PRD. To re-introduce it, fix the
issue manually and move the directory back under prds/<status>/.
`;
	await writeFile(reportPath, body);

	report.quarantined.push({
		project: projectName,
		prdName,
		from: `prds/${status}/${prdName}`,
		to: `old/${status}-${prdName}`,
		reason,
	});
	report.actions.push({
		kind: "quarantine_prd",
		project: projectName,
		path: `prds/${status}/${prdName} → old/${status}-${prdName}`,
		detail: reason,
	});
}

async function migrateProject(
	projectName: string,
	projectDir: string,
	report: MigrationReport,
): Promise<void> {
	await migrateStatusDirs(projectName, projectDir, report);

	const prdsDir = join(projectDir, "prds");
	if (!isDir(prdsDir)) return;

	const statuses = ["pending", "in_progress", "qa", "completed"];
	for (const status of statuses) {
		const statusDir = join(prdsDir, status);
		if (!isDir(statusDir)) continue;

		for (const prdName of safeReaddir(statusDir)) {
			const prdDir = join(statusDir, prdName);
			if (!isDir(prdDir)) continue;

			const hasPrdJson = existsSync(join(prdDir, "prd.json"));
			const hasSpec = existsSync(join(prdDir, "spec.md"));

			if (!hasPrdJson && !hasSpec) {
				await quarantinePRD(
					projectName,
					projectDir,
					prdDir,
					prdName,
					status,
					"directory contains neither prd.json nor spec.md",
					report,
				);
				continue;
			}

			try {
				await migratePRDJson(projectName, prdDir, prdName, report);
				await migrateTestResultsDir(projectName, prdDir, prdName, report);
			} catch (err) {
				await quarantinePRD(
					projectName,
					projectDir,
					prdDir,
					prdName,
					status,
					`migration threw: ${err instanceof Error ? err.message : String(err)}`,
					report,
				);
			}
		}
	}
}

/**
 * Run the Ralph 2.1 migration across every project under the XDG state root.
 * Idempotent: re-runs after a successful migration are no-ops.
 */
export async function runMigration(): Promise<MigrationReport> {
	const stateRoot = join(getXdgStateHome(), "omnidev", "ralph");
	const report: MigrationReport = {
		stateRoot,
		projects: [],
		actions: [],
		warnings: [],
		quarantined: [],
	};

	if (!isDir(stateRoot)) {
		report.warnings.push(`State root not found: ${stateRoot} — nothing to migrate`);
		return report;
	}

	for (const projectName of safeReaddir(stateRoot)) {
		const projectDir = join(stateRoot, projectName);
		if (!isDir(projectDir)) continue;
		report.projects.push(projectName);
		await migrateProject(projectName, projectDir, report);
	}

	return report;
}

/**
 * Format a migration report for terminal output.
 */
export function formatMigrationReport(report: MigrationReport): string {
	const lines: string[] = [];
	lines.push(`Ralph migrate — state root: ${report.stateRoot}`);
	lines.push(`Projects scanned: ${report.projects.length}`);
	lines.push(`Actions applied: ${report.actions.length}`);
	lines.push(`Warnings: ${report.warnings.length}`);
	lines.push(`Quarantined: ${report.quarantined.length}`);
	lines.push("");

	if (report.actions.length > 0) {
		lines.push("=== Actions ===");
		for (const a of report.actions) {
			const detail = a.detail ? ` — ${a.detail}` : "";
			lines.push(`  [${a.kind}] ${a.project}: ${a.path}${detail}`);
		}
		lines.push("");
	}

	if (report.warnings.length > 0) {
		lines.push("=== Warnings ===");
		for (const w of report.warnings) lines.push(`  ${w}`);
		lines.push("");
	}

	if (report.quarantined.length > 0) {
		lines.push("=== Quarantined ===");
		for (const q of report.quarantined) {
			lines.push(`  ${q.project}: ${q.from} → ${q.to}`);
			lines.push(`    reason: ${q.reason}`);
		}
		lines.push("");
	}

	if (report.actions.length === 0 && report.quarantined.length === 0) {
		lines.push("Nothing to migrate — state already matches Ralph 2.1 layout.");
	}

	return lines.join("\n");
}
