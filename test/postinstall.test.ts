import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMissingCargoMessage,
  formatSkippedBuildMessage,
  runPostinstall,
  shouldSkipExecutorBuild,
} from "../scripts/postinstall.mjs";

test("postinstall build skip requires an explicit opt-in value", () => {
  assert.equal(shouldSkipExecutorBuild({ CONGREX_SKIP_EXECUTOR_BUILD: "1" }), true);
  assert.equal(shouldSkipExecutorBuild({ CONGREX_SKIP_EXECUTOR_BUILD: "true" }), false);
  assert.equal(shouldSkipExecutorBuild({}), false);
});

test("postinstall missing cargo message is actionable", () => {
  const message = formatMissingCargoMessage();
  assert.match(message, /cargo/);
  assert.match(message, /https:\/\/rustup\.rs\//);
  assert.match(message, /npm install -g congrex/);
});

test("postinstall skipped build message does not imply a functional executor", () => {
  const message = formatSkippedBuildMessage();
  assert.match(message, /CONGREX_SKIP_EXECUTOR_BUILD=1/);
  assert.match(message, /execution features will not work/);
  assert.match(message, /CONGREX_EXECUTOR_BIN/);
});

test("runPostinstall skip branch warns when no executor binary exists", () => {
  const warnings = [];
  const spawned = [];
  const exitCode = runPostinstall(
    { CONGREX_SKIP_EXECUTOR_BUILD: "1" },
    {
      existsSync() {
        return false;
      },
      spawnSync(...args) {
        spawned.push(args);
        return { status: 0 };
      },
      console: {
        log(message) {
          throw new Error(`unexpected log: ${message}`);
        },
        error(message) {
          throw new Error(`unexpected error: ${message}`);
        },
        warn(message) {
          warnings.push(String(message));
        },
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(spawned, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /execution features will not work/);
  assert.match(warnings[0], /executor is built or CONGREX_EXECUTOR_BIN points to a valid binary/);
});
