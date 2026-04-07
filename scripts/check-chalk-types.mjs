import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = new URL("../src/", import.meta.url);
const FORBIDDEN = /\bChalkInstance\b/;

function* walk(dirUrl) {
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
    if (entry.isDirectory()) {
      yield* walk(entryUrl);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield entryUrl;
    }
  }
}

const offenders = [];

for (const fileUrl of walk(ROOT)) {
  const filePath = fileUrl.pathname;
  const text = readFileSync(fileUrl, "utf8");
  if (FORBIDDEN.test(text)) {
    offenders.push(path.relative(process.cwd(), filePath));
  }
}

if (offenders.length > 0) {
  console.error("Invalid Chalk type usage detected.");
  console.error("Use the local ChalkLike type instead of package-specific ChalkInstance.");
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}
