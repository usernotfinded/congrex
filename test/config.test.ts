import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolveProviderEnvApiKey, resolveSenatorApiKey } from "../src/apiKeys.js";
import {
  LOCAL_OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  createEmptySession,
  getConfigDir,
  getSenatorsFilePath,
  isManualEndpointProvider,
  listRecentSessions,
  loadAppConfig,
  loadSenators,
  loadSession,
  resolveProviderBaseUrl,
  saveAppConfig,
  saveSession,
  saveSenators,
  type SenatorConfig,
} from "../src/config.js";

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

async function listConfigTempFiles(): Promise<string[]> {
  try {
    const entries = await readdir(getConfigDir());
    return entries.filter((entry) => entry.endsWith(".tmp"));
  } catch {
    return [];
  }
}

test("save/load preserves apiKeyEnvVar and never writes the resolved secret value", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    // Intentionally fake and shaped to avoid matching real provider token formats.
    const secretValue = "TEST_FAKE_API_KEY_VALUE_DO_NOT_USE";
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
      assert.deepEqual(await listConfigTempFiles(), []);
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

test("loadSenators accepts openrouter as a supported provider", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    const senatorsFilePath = getSenatorsFilePath();
    await mkdir(path.dirname(senatorsFilePath), { recursive: true });
    await writeFile(
      senatorsFilePath,
      `${JSON.stringify({
        version: 1,
        senators: [
          {
            id: "openrouter-1",
            name: "OpenRouter Senator",
            provider: "openrouter",
            modelId: "openai/gpt-4o-mini",
            createdAt: "2026-04-05T00:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const loaded = await loadSenators();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.provider, "openrouter");
    assert.equal(loaded[0]?.modelId, "openai/gpt-4o-mini");
  });
});

test("save/load roundtrip preserves openrouter senators without a manual base URL", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    await saveSenators([
      createSenator({
        name: "OpenRouter Roundtrip",
        provider: "openrouter",
        modelId: "openai/gpt-4o-mini",
        baseUrl: undefined,
      }),
    ]);

    const loaded = await loadSenators();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.provider, "openrouter");
    assert.equal(loaded[0]?.modelId, "openai/gpt-4o-mini");
    assert.equal(loaded[0]?.baseUrl, undefined);
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

test("custom OpenAI-compatible providers resolve apiKeyEnvVar before apiKey", { concurrency: false }, () => {
  const customSenator = createSenator({
    provider: "custom",
    apiKey: "stored-custom-key",
    apiKeyEnvVar: "CONGREX_CUSTOM_COMPAT_KEY",
  });

  assert.equal(
    resolveSenatorApiKey(customSenator, {
      CONGREX_CUSTOM_COMPAT_KEY: "env-custom-key",
    }),
    "env-custom-key",
  );

  assert.equal(
    resolveSenatorApiKey(customSenator, {}),
    "stored-custom-key",
  );
});

test("resolveProviderEnvApiKey recognizes OPENROUTER_API_KEY", { concurrency: false }, () => {
  assert.equal(
    resolveProviderEnvApiKey("openrouter", {
      OPENROUTER_API_KEY: "openrouter-api-key",
    }),
    "openrouter-api-key",
  );
});

test("openrouter providers follow apiKeyEnvVar -> apiKey -> OPENROUTER_API_KEY precedence", { concurrency: false }, () => {
  const openrouterSenator = createSenator({
    provider: "openrouter",
    apiKey: "stored-openrouter-key",
    apiKeyEnvVar: "CONGREX_OPENROUTER_KEY",
  });

  assert.equal(
    resolveSenatorApiKey(openrouterSenator, {
      CONGREX_OPENROUTER_KEY: "env-openrouter-key",
      OPENROUTER_API_KEY: "provider-openrouter-key",
    }),
    "env-openrouter-key",
  );

  assert.equal(
    resolveSenatorApiKey(openrouterSenator, {
      OPENROUTER_API_KEY: "provider-openrouter-key",
    }),
    "stored-openrouter-key",
  );

  assert.equal(
    resolveSenatorApiKey(
      createSenator({
        provider: "openrouter",
        apiKeyEnvVar: "CONGREX_OPENROUTER_KEY",
      }),
      {
        OPENROUTER_API_KEY: "openrouter-api-key",
      },
    ),
    "openrouter-api-key",
  );
});

test("provider base URL defaults keep openrouter hosted while custom remains manual", { concurrency: false }, () => {
  assert.equal(resolveProviderBaseUrl("openrouter"), OPENROUTER_BASE_URL);
  assert.equal(resolveProviderBaseUrl("openrouter", "https://override.example/v1"), "https://override.example/v1");
  assert.equal(resolveProviderBaseUrl("custom"), undefined);
  assert.equal(resolveProviderBaseUrl("local"), LOCAL_OPENAI_BASE_URL);
  assert.equal(isManualEndpointProvider("custom"), true);
  assert.equal(isManualEndpointProvider("local"), true);
  assert.equal(isManualEndpointProvider("openrouter"), false);
});

test("local OpenAI-compatible providers resolve optional keys through the shared resolver", { concurrency: false }, () => {
  const localSenator = createSenator({
    provider: "local",
    apiKey: "stored-local-key",
    apiKeyEnvVar: "CONGREX_LOCAL_COMPAT_KEY",
  });

  assert.equal(
    resolveSenatorApiKey(localSenator, {
      CONGREX_LOCAL_COMPAT_KEY: "env-local-key",
    }),
    "env-local-key",
  );

  assert.equal(
    resolveSenatorApiKey(localSenator, {}),
    "stored-local-key",
  );
});

test("save/load preserves app config without leaving temp files behind", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    await saveAppConfig({
      presidentId: "senator-2",
      presets: {
        core: ["senator-1", "senator-2"],
      },
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
      },
    });

    assert.deepEqual(await loadAppConfig(), {
      presidentId: "senator-2",
      presets: {
        core: ["senator-1", "senator-2"],
      },
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
      },
    });
    assert.deepEqual(await listConfigTempFiles(), []);
  });
});

test("invalid but parseable session files are rejected and skipped", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    const sessionsDir = path.join(getConfigDir(), "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "broken.json"),
      `${JSON.stringify({
        id: "broken",
        createdAt: "2026-04-05T00:00:00.000Z",
        updatedAt: "2026-04-05T00:00:00.000Z",
        turns: [{}],
      }, null, 2)}\n`,
      "utf8",
    );

    assert.equal(await loadSession("broken"), null);
    assert.deepEqual(await listRecentSessions(10), []);
  });
});

test("valid saved sessions remain loadable and appear in recent session summaries", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    const session = createEmptySession("valid-session");
    session.turns.push({
      userPrompt: "how should we refactor auth?",
      consensusText: "extract the auth adapter",
      winnerId: "senator-1",
    });

    await saveSession(session);

    const loaded = await loadSession("valid-session");
    assert.equal(loaded?.id, "valid-session");
    assert.equal(loaded?.turns.length, 1);
    assert.equal(loaded?.turns[0]?.consensusText, "extract the auth adapter");

    const summaries = await listRecentSessions(10);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.id, "valid-session");
    assert.equal(summaries[0]?.firstPrompt, "how should we refactor auth?");
    assert.equal(summaries[0]?.turnCount, 1);
  });
});

test("save/load preserves optional chamber snapshot for sessions", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    const session = createEmptySession("session-with-chamber");
    session.turns.push({
      userPrompt: "hello",
      consensusText: "world",
      winnerId: "senator-2",
    });
    session.chamberSnapshot = {
      activeSenatorIds: ["senator-2", "senator-1"],
      presidentId: "senator-2",
    };

    await saveSession(session);

    const loaded = await loadSession(session.id);
    assert.deepEqual(loaded?.chamberSnapshot, {
      activeSenatorIds: ["senator-2", "senator-1"],
      presidentId: "senator-2",
    });
  });
});

test("legacy session files without chamber snapshot still load", { concurrency: false }, async () => {
  await withTempConfigDir(async () => {
    const sessionsDir = path.join(getConfigDir(), "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, "legacy-session.json"),
      `${JSON.stringify({
        id: "legacy-session",
        createdAt: "2026-04-05T00:00:00.000Z",
        updatedAt: "2026-04-05T00:00:00.000Z",
        turns: [
          {
            userPrompt: "old prompt",
            consensusText: "old answer",
            winnerId: "senator-1",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const loaded = await loadSession("legacy-session");
    assert.equal(loaded?.id, "legacy-session");
    assert.equal(loaded?.chamberSnapshot, undefined);
  });
});
