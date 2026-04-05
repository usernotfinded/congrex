import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const chalk = require("chalk") as any;
const updateNotifier = require("update-notifier") as (options: {
  pkg: { name: string; version: string };
  updateCheckInterval: number;
}) => { update?: { current: string; latest: string } };
const pkg = require("../../package.json") as { name: string; version: string };

export function initUpdateNotifier(): void {
  if (process.env.NO_UPDATE_NOTIFIER === "1") return;
  try {
    const notifier = updateNotifier({ pkg, updateCheckInterval: 0 });
    if (!notifier.update || !process.stdout.isTTY) return;
    console.log(chalk.yellow(`Update available: ${notifier.update.current} → ${notifier.update.latest}`));
    console.log(chalk.dim(`Run: npm install -g ${pkg.name}@latest`));
    console.log("");
  } catch {}
}

export function runSelfUpdate(): number {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "-g", `${pkg.name}@latest`], { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(chalk.red(`Self-update failed: ${result.error.message}`));
    return 1;
  }
  return result.status ?? 0;
}
