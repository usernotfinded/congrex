import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executorDir = path.join(rootDir, "congrex-executor");
const binaryName = process.platform === "win32" ? "congrex-executor.exe" : "congrex-executor";
const binaryPath = path.join(executorDir, "target", "release", binaryName);

export function shouldSkipExecutorBuild(env = process.env) {
  return env.CONGREX_SKIP_EXECUTOR_BUILD === "1";
}

export function formatMissingCargoMessage() {
  return [
    "[congrex] Rust toolchain not found: `cargo` is required to build the local executor.",
    "[congrex] Install Rust from https://rustup.rs/ and then re-run `npm install -g congrex`.",
    "[congrex] For docs-only or development installs that will not run Congrex yet, set CONGREX_SKIP_EXECUTOR_BUILD=1.",
    "[congrex] If the build is skipped, Congrex execution features will not work until the executor is built or CONGREX_EXECUTOR_BIN points to a valid binary.",
  ].join("\n");
}

export function formatSkippedBuildMessage() {
  return [
    "[congrex] Skipping Rust executor build because CONGREX_SKIP_EXECUTOR_BUILD=1.",
    "[congrex] Congrex execution features will not work until the executor is built or CONGREX_EXECUTOR_BIN points to a valid binary.",
  ].join("\n");
}

export function runPostinstall(env = process.env, deps = {}) {
  const fileExists = deps.existsSync ?? existsSync;
  const spawn = deps.spawnSync ?? spawnSync;
  const output = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    ...deps.console,
  };
  const overrideBinary = env.CONGREX_EXECUTOR_BIN?.trim();

  if (overrideBinary) {
    if (fileExists(overrideBinary)) {
      output.log(`[congrex] Using CONGREX_EXECUTOR_BIN=${overrideBinary}`);
      return 0;
    }
    output.error(`[congrex] CONGREX_EXECUTOR_BIN is set but does not exist: ${overrideBinary}`);
    return 1;
  }

  if (fileExists(binaryPath)) {
    output.log(`[congrex] Rust executor already present at ${binaryPath}`);
    return 0;
  }

  if (shouldSkipExecutorBuild(env)) {
    output.warn(formatSkippedBuildMessage());
    return 0;
  }

  if (!fileExists(path.join(executorDir, "Cargo.toml"))) {
    output.error("[congrex] Missing congrex-executor sources. Reinstall the package.");
    return 1;
  }

  const cargoCheck = spawn("cargo", ["--version"], {
    cwd: executorDir,
    stdio: "ignore",
    shell: false,
  });

  if (cargoCheck.error) {
    if ("code" in cargoCheck.error && cargoCheck.error.code === "ENOENT") {
      output.error(formatMissingCargoMessage());
    } else {
      output.error(`[congrex] Failed to start cargo: ${cargoCheck.error.message}`);
    }
    return 1;
  }

  if (cargoCheck.status !== 0) {
    output.error("[congrex] `cargo --version` failed. Verify that Rust is installed and available on PATH.");
    return cargoCheck.status ?? 1;
  }

  output.log("[congrex] Building Rust executor (cargo build --release)...");

  const result = spawn("cargo", ["build", "--release"], {
    cwd: executorDir,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    output.error(`[congrex] Failed to start cargo: ${result.error.message}`);
    return 1;
  }

  if (result.status !== 0) {
    output.error("[congrex] cargo build --release failed.");
    return result.status ?? 1;
  }

  if (!fileExists(binaryPath)) {
    output.error(`[congrex] Build completed but executor binary was not found at ${binaryPath}`);
    return 1;
  }

  output.log(`[congrex] Rust executor ready: ${binaryPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runPostinstall());
}
