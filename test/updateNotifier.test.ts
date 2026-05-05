import test from "node:test";
import assert from "node:assert/strict";
import { initUpdateNotifier, runManualUpdate } from "../src/utils/updateNotifier.js";

const pkg = { name: "congrex", version: "1.0.6" };

function createOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    console: {
      log(message: unknown = "") {
        logs.push(String(message));
      },
      error(message: unknown = "") {
        errors.push(String(message));
      },
    },
  };
}

test("update notification prints newer version and suggests /update", () => {
  const output = createOutput();

  initUpdateNotifier({
    pkg,
    stdoutIsTTY: true,
    console: output.console,
    updateNotifier() {
      return { update: { current: "1.0.6", latest: "1.0.7" } };
    },
  });

  assert.match(output.logs.join("\n"), /Update available: 1\.0\.6 .* 1\.0\.7/);
  assert.match(output.logs.join("\n"), /Run \/update to install now\./);
});

test("update notification is silent when no update is available", () => {
  const output = createOutput();

  initUpdateNotifier({
    pkg,
    stdoutIsTTY: true,
    console: output.console,
    updateNotifier() {
      return {};
    },
  });

  assert.deepEqual(output.logs, []);
  assert.deepEqual(output.errors, []);
});

test("update notification failure does not crash", () => {
  const output = createOutput();

  assert.doesNotThrow(() => {
    initUpdateNotifier({
      pkg,
      stdoutIsTTY: true,
      console: output.console,
      updateNotifier() {
        throw new Error("network unavailable");
      },
    });
  });
  assert.deepEqual(output.logs, []);
  assert.deepEqual(output.errors, []);
});

test("/update does nothing when Congrex is already current", async () => {
  const output = createOutput();
  const result = await runManualUpdate({
    pkg,
    console: output.console,
    getLatestVersion: () => "1.0.6",
    prompt: () => {
      throw new Error("prompt should not run");
    },
    spawnSync: () => {
      throw new Error("npm install should not run");
    },
  });

  assert.deepEqual(result, { status: 0, attemptedInstall: false });
  assert.match(output.logs.join("\n"), /already up to date/);
});

test("/update does not run npm when user answers no", async () => {
  const output = createOutput();
  const result = await runManualUpdate({
    pkg,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    console: output.console,
    getLatestVersion: () => "1.0.7",
    prompt: () => "no",
    spawnSync: () => {
      throw new Error("npm install should not run");
    },
  });

  assert.deepEqual(result, { status: 0, attemptedInstall: false });
  assert.match(output.logs.join("\n"), /Update cancelled/);
});

test("/update default enter does not run npm", async () => {
  const output = createOutput();
  const result = await runManualUpdate({
    pkg,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    console: output.console,
    getLatestVersion: () => "1.0.7",
    prompt: () => "",
    spawnSync: () => {
      throw new Error("npm install should not run");
    },
  });

  assert.deepEqual(result, { status: 0, attemptedInstall: false });
  assert.match(output.logs.join("\n"), /Update cancelled/);
});

for (const answer of ["y", "yes", "Y", "YES"]) {
  test(`/update runs npm install after explicit ${answer}`, async () => {
    const output = createOutput();
    const spawns: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const prompts: string[] = [];
    const result = await runManualUpdate({
      pkg,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      platform: "linux",
      console: output.console,
      getLatestVersion: () => "1.0.7",
      prompt(message) {
        prompts.push(message);
        return answer;
      },
      spawnSync(command, args, options) {
        spawns.push({ command, args, options });
        return { status: 0 };
      },
    });

    assert.deepEqual(result, { status: 0, attemptedInstall: true });
    assert.deepEqual(prompts, ["Install Congrex 1.0.7 now? [y/N] "]);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, "npm");
    assert.deepEqual(spawns[0].args, ["install", "-g", "congrex@latest"]);
    assert.equal(spawns[0].options.shell, false);
    assert.equal(spawns[0].options.stdio, "inherit");
    assert.match(output.logs.join("\n"), /Restart Congrex/);
  });
}

test("/update reports npm failure", async () => {
  const output = createOutput();
  const result = await runManualUpdate({
    pkg,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    console: output.console,
    getLatestVersion: () => "1.0.7",
    prompt: () => "y",
    spawnSync() {
      return { status: 13 };
    },
  });

  assert.deepEqual(result, { status: 13, attemptedInstall: true });
  assert.match(output.errors.join("\n"), /Self-update failed with exit code 13/);
});

test("/update does not prompt or install in noninteractive mode", async () => {
  const output = createOutput();
  const result = await runManualUpdate({
    pkg,
    stdinIsTTY: false,
    stdoutIsTTY: true,
    console: output.console,
    getLatestVersion: () => "1.0.7",
    prompt: () => {
      throw new Error("prompt should not run");
    },
    spawnSync: () => {
      throw new Error("npm install should not run");
    },
  });

  assert.deepEqual(result, { status: 1, attemptedInstall: false });
  assert.match(output.errors.join("\n"), /requires an interactive terminal/);
});

test("/update check failure reports error without installing", async () => {
  const output = createOutput();
  const result = await runManualUpdate({
    pkg,
    console: output.console,
    getLatestVersion: () => {
      throw new Error("offline");
    },
    spawnSync: () => {
      throw new Error("npm install should not run");
    },
  });

  assert.deepEqual(result, { status: 1, attemptedInstall: false });
  assert.match(output.errors.join("\n"), /Unable to check for updates: offline/);
});
