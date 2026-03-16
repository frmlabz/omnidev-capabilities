import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTmpTestDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function cleanupTmpTestDir(testDir: string): void {
	if (testDir !== "" && existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
}
