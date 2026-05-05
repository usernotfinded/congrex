import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(rootDir, "test");

const testFiles = readdirSync(testDir)
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort()
  .map((entry) => path.join("test", entry));

if (testFiles.length === 0) {
  console.error("[congrex] No test files found in test/*.test.ts");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  cwd: rootDir,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`[congrex] Failed to start Node test runner: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
