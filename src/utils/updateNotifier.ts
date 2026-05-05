import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import type { ChalkLike } from "../chalkLike.js";

const require = createRequire(import.meta.url);
const chalk = require("chalk") as ChalkLike;
const updateNotifier = require("update-notifier") as (options: {
  pkg: PackageInfo;
  updateCheckInterval: number;
}) => { update?: UpdateInfo };
const pkg = require("../../package.json") as PackageInfo;

type PackageInfo = { name: string; version: string };
type UpdateInfo = { current: string; latest: string };
type Output = Pick<Console, "log" | "error">;
type SpawnResult = {
  status: number | null;
  stdout?: unknown;
  stderr?: unknown;
  error?: Error;
};

type SpawnRunner = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => SpawnResult;

export type ManualUpdateResult = {
  status: number;
  attemptedInstall: boolean;
};

type UpdateNotifierDeps = {
  env?: NodeJS.ProcessEnv;
  pkg?: PackageInfo;
  console?: Partial<Output>;
  stdoutIsTTY?: boolean;
  updateNotifier?: typeof updateNotifier;
};

type ManualUpdateDeps = {
  pkg?: PackageInfo;
  console?: Partial<Output>;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  platform?: NodeJS.Platform;
  spawnSync?: SpawnRunner;
  getLatestVersion?: (packageInfo: PackageInfo) => string | Promise<string>;
  prompt?: (message: string) => string | Promise<string>;
};

function outputFrom(override?: Partial<Output>): Output {
  return {
    log: console.log,
    error: console.error,
    ...override,
  };
}

function npmCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function outputToString(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let i = 0; i < length; i++) {
    const leftPart = Number.isFinite(leftParts[i]) ? leftParts[i] : 0;
    const rightPart = Number.isFinite(rightParts[i]) ? rightParts[i] : 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

function isExplicitYes(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function fetchLatestVersion(packageInfo: PackageInfo, deps: ManualUpdateDeps): string {
  const spawn = deps.spawnSync ?? spawnSync;
  const npm = npmCommand(deps.platform ?? process.platform);
  const result = spawn(npm, ["view", `${packageInfo.name}@latest`, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = outputToString(result.stderr).trim();
    throw new Error(stderr || `npm view exited with status ${result.status ?? 1}`);
  }

  const latest = normalizeVersion(outputToString(result.stdout));
  if (!latest) {
    throw new Error("npm did not return a latest version");
  }
  return latest;
}

async function promptLine(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

function runInstall(packageInfo: PackageInfo, deps: ManualUpdateDeps): SpawnResult {
  const spawn = deps.spawnSync ?? spawnSync;
  const npm = npmCommand(deps.platform ?? process.platform);
  return spawn(npm, ["install", "-g", `${packageInfo.name}@latest`], {
    stdio: "inherit",
    shell: false,
  });
}

export function initUpdateNotifier(deps: UpdateNotifierDeps = {}): void {
  if ((deps.env ?? process.env).NO_UPDATE_NOTIFIER === "1") return;
  try {
    const packageInfo = deps.pkg ?? pkg;
    const notifier = (deps.updateNotifier ?? updateNotifier)({ pkg: packageInfo, updateCheckInterval: 0 });
    if (!notifier.update || !(deps.stdoutIsTTY ?? process.stdout.isTTY)) return;

    const output = outputFrom(deps.console);
    output.log(chalk.yellow(`Update available: ${notifier.update.current} → ${notifier.update.latest}`));
    output.log(chalk.dim("Run /update to install now."));
    output.log("");
  } catch {}
}

export async function runManualUpdate(deps: ManualUpdateDeps = {}): Promise<ManualUpdateResult> {
  const packageInfo = deps.pkg ?? pkg;
  const output = outputFrom(deps.console);
  let latest: string;

  try {
    const lookup = deps.getLatestVersion ?? ((info: PackageInfo) => fetchLatestVersion(info, deps));
    latest = normalizeVersion(await lookup(packageInfo));
  } catch (error) {
    output.error(chalk.red(`Unable to check for updates: ${error instanceof Error ? error.message : String(error)}`));
    return { status: 1, attemptedInstall: false };
  }

  if (!latest) {
    output.error(chalk.red("Unable to check for updates: npm did not return a latest version."));
    return { status: 1, attemptedInstall: false };
  }

  if (!isNewerVersion(packageInfo.version, latest)) {
    output.log(chalk.green(`Congrex is already up to date (${packageInfo.version}).`));
    return { status: 0, attemptedInstall: false };
  }

  output.log(chalk.yellow(`Update available: ${packageInfo.version} → ${latest}`));

  const interactive = (deps.stdinIsTTY ?? process.stdin.isTTY) && (deps.stdoutIsTTY ?? process.stdout.isTTY);
  if (!interactive) {
    output.error(chalk.red("Manual update requires an interactive terminal; not installing."));
    return { status: 1, attemptedInstall: false };
  }

  const prompt = deps.prompt ?? promptLine;
  const answer = await prompt(`Install Congrex ${latest} now? [y/N] `);
  if (!isExplicitYes(answer)) {
    output.log(chalk.dim("Update cancelled."));
    return { status: 0, attemptedInstall: false };
  }

  output.log(chalk.dim(`Running: npm install -g ${packageInfo.name}@latest`));
  const result = runInstall(packageInfo, deps);
  if (result.error) {
    output.error(chalk.red(`Self-update failed: ${result.error.message}`));
    return { status: 1, attemptedInstall: true };
  }

  const status = result.status ?? 0;
  if (status !== 0) {
    output.error(chalk.red(`Self-update failed with exit code ${status}.`));
    return { status, attemptedInstall: true };
  }

  output.log(chalk.green("Congrex update finished. Restart Congrex for the new version to take effect."));
  return { status: 0, attemptedInstall: true };
}
