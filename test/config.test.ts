import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolveSenatorApiKey } from "../src/apiKeys.js";
import { getSenatorsFilePath, loadSenators, saveSenators, type SenatorConfig } from "../src/config.js";

async function withTempConfigDir(run: () => Promise<void>): Promise<void> {
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "congrex-config-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;

  try {
    await run();
  } finally {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createSenator(overrides: Partial<SenatorConfig> = {}): SenatorConfig {
  return {
    id: "senator-1",
    name: "OpenAI Senator",
    provider: "openai",
    modelId: "gpt-5",
    createdAt: "2026-04-05T00:00:00.000Z",
    ...overrides,
  };
}

test("save/load preserves apiKeyEnvVar and never writes the resolved secret value", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    const secretValue = "sk-live-secret-value";
    process.env.CONGREX_TEST_OPENAI_KEY = secretValue;
    try {
      await saveSenators([
        createSenator({
          apiKeyEnvVar: "CONGREX_TEST_OPENAI_KEY",
        }),
      ]);

      const raw = await readFile(getSenatorsFilePath(), "utf8");
      assert.match(raw, /"apiKeyEnvVar": "CONGREX_TEST_OPENAI_KEY"/);
      assert.equal(raw.includes(secretValue), false);

      const loaded = await loadSenators();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.apiKeyEnvVar, "CONGREX_TEST_OPENAI_KEY");
    } finally {
      delete process.env.CONGREX_TEST_OPENAI_KEY;
    }
  });
});

test("loadSenators stays backward compatible when apiKeyEnvVar is missing", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    const senatorsFilePath = getSenatorsFilePath();
    await mkdir(path.dirname(senatorsFilePath), { recursive: true });
    await writeFile(
      senatorsFilePath,
      `${JSON.stringify({
        version: 1,
        senators: [
          {
            id: "legacy-1",
            name: "Legacy Senator",
            provider: "openai",
            apiKey: "stored-key",
            modelId: "gpt-4.1",
            createdAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const loaded = await loadSenators();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.apiKey, "stored-key");
    assert.equal(loaded[0]?.apiKeyEnvVar, undefined);
  });
});

test("apiKeyEnvVar takes precedence over apiKey, with deterministic fallback to apiKey and provider env vars", { concurrency: false }, () => {
  const senator = createSenator({
    apiKey: "stored-api-key",
    apiKeyEnvVar: "CONGREX_CUSTOM_KEY",
  });

  assert.equal(
    resolveSenatorApiKey(senator, {
      CONGREX_CUSTOM_KEY: "env-api-key",
      OPENAI_API_KEY: "provider-api-key",
    }),
    "env-api-key",
  );

  assert.equal(
    resolveSenatorApiKey(senator, {
      OPENAI_API_KEY: "provider-api-key",
    }),
    "stored-api-key",
  );

  assert.equal(
    resolveSenatorApiKey(
      createSenator({
        apiKeyEnvVar: "CONGREX_CUSTOM_KEY",
      }),
      {
        OPENAI_API_KEY: "provider-api-key",
      },
    ),
    "provider-api-key",
  );
});
