import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = path.join(rootDir, "dist", "index.js");
const shebang = "#!/usr/bin/env node";

if (!existsSync(entryPath)) {
  console.error(`[congrex] build output not found: ${entryPath}`);
  process.exit(1);
}

const content = readFileSync(entryPath, "utf8");
const updated = content.startsWith(shebang) ? content : `${shebang}\n${content}`;

if (updated !== content) {
  writeFileSync(entryPath, updated, "utf8");
}

try {
  chmodSync(entryPath, 0o755);
} catch {
  // Best effort only; npm bin linking still works on supported platforms.
}
