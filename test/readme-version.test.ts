import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("README public version string matches package.json", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { version: string };
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const expectedVersion = `v${packageJson.version}`;
  const mentionedVersions = [...readme.matchAll(/\bv\d+\.\d+\.\d+\b/g)].map((match) => match[0]);

  assert.ok(mentionedVersions.length > 0, "README.md should contain at least one public-facing version string.");
  assert.deepEqual(
    [...new Set(mentionedVersions)],
    [expectedVersion],
    "README.md contains a version string that does not match package.json.",
  );
  assert.match(
    readme,
    new RegExp(`^# Congrex AI Senate \\(${escapeRegExp(expectedVersion)}\\)$`, "m"),
    "README title should expose the package version from package.json.",
  );
});
