import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolveSenatorApiKey } from "../src/apiKeys.js";
import {
  createEmptySession,
  getConfigDir,
  getSenatorsFilePath,
  listRecentSessions,
  loadSenators,
  loadSession,
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
