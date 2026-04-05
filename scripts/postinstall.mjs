import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executorDir = path.join(rootDir, "congrex-executor");
const binaryName = process.platform === "win32" ? "congrex-executor.exe" : "congrex-executor";
const binaryPath = path.join(executorDir, "target", "release", binaryName);
const overrideBinary = process.env.CONGREX_EXECUTOR_BIN?.trim();

if (overrideBinary && existsSync(overrideBinary)) {
  console.log(`[congrex] Using CONGREX_EXECUTOR_BIN=${overrideBinary}`);
  process.exit(0);
}

if (existsSync(binaryPath)) {
  console.log(`[congrex] Rust executor already present at ${binaryPath}`);
  process.exit(0);
}

if (!existsSync(path.join(executorDir, "Cargo.toml"))) {
  console.error("[congrex] Missing congrex-executor sources. Reinstall the package.");
  process.exit(1);
}

console.log("[congrex] Building Rust executor (cargo build --release)...");

const result = spawnSync("cargo", ["build", "--release"], {
  cwd: executorDir,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  if ("code" in result.error && result.error.code === "ENOENT") {
    console.error("[congrex] Rust toolchain not found. Install Rust from https://rustup.rs/ and then re-run `npm install -g congrex`.");
  } else {
    console.error(`[congrex] Failed to start cargo: ${result.error.message}`);
  }
  process.exit(1);
}

if (result.status !== 0) {
  console.error("[congrex] cargo build --release failed.");
  process.exit(result.status ?? 1);
}

if (!existsSync(binaryPath)) {
  console.error(`[congrex] Build completed but executor binary was not found at ${binaryPath}`);
  process.exit(1);
}

console.log(`[congrex] Rust executor ready: ${binaryPath}`);
