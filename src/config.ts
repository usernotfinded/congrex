import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Provider = "openai" | "anthropic" | "google" | "xai" | "custom" | "local";

export interface SenatorConfig {
  id: string;
  name: string;
  provider: Provider;
  /**
   * API key stored directly in the config file.
   *
   * SECURITY NOTE: This stores the key in plaintext on disk at
   * ~/.config/congrex/senators.json (mode 0o600). For better security,
   * use environment variables instead:
   *   - OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, XAI_API_KEY
   * These are resolved automatically by requireApiKey() when apiKey is empty.
   *
   * Alternatively, set `apiKeyEnvVar` to a custom env var name.
   */
  apiKey?: string;
  /**
   * [P2 FIX] Name of an environment variable containing the API key.
   * When set, the key is read from this env var at runtime instead of
   * being stored on disk. Example: "MY_CUSTOM_OPENAI_KEY"
   */
  apiKeyEnvVar?: string;
  modelId: string;
  baseUrl?: string;
  expertise?: string;
  active?: boolean;
  createdAt: string;
}

interface SenatorsStore {
  version: 1;
  senators: SenatorConfig[];
}

type SenatorConfigRecord = Partial<SenatorConfig> & {
  model?: string;
};

type LoadedSenatorRecord = {
  id: string;
  name: string;
  provider: Provider;
  apiKey?: string;
  apiKeyEnvVar?: string;
  modelId?: string;
  model?: string;
  baseUrl?: string;
  expertise?: string;
  active?: boolean;
  createdAt: string;
};

const STORE_VERSION = 1;
const APP_NAME = "congrex";
const SUPPORTED_PROVIDERS = new Set<Provider>(["openai", "anthropic", "google", "xai", "custom", "local"]);
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeOptionalEnvVarName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return ENV_VAR_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

function normalizeSenatorForPersistence(senator: SenatorConfig): SenatorConfig {
  return {
    ...senator,
    apiKey: senator.apiKey || undefined,
    apiKeyEnvVar: normalizeOptionalEnvVarName(senator.apiKeyEnvVar),
    baseUrl: senator.baseUrl || undefined,
    expertise: senator.expertise || undefined,
  };
}

function isLoadedSenatorRecord(senator: SenatorConfigRecord): senator is LoadedSenatorRecord {
  const modelId = typeof senator?.modelId === "string" ? senator.modelId : senator?.model;

  return Boolean(
    senator &&
      typeof senator.id === "string" &&
      typeof senator.name === "string" &&
      typeof senator.provider === "string" &&
      SUPPORTED_PROVIDERS.has(senator.provider as Provider) &&
      (typeof senator.apiKey === "string" || typeof senator.apiKey === "undefined") &&
      (typeof senator.apiKeyEnvVar === "string" || typeof senator.apiKeyEnvVar === "undefined") &&
      typeof modelId === "string" &&
      typeof senator.createdAt === "string",
  );
}

export function getConfigDir(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME;
  if (xdgHome) {
    return path.join(xdgHome, APP_NAME);
  }

  return path.join(os.homedir(), ".config", APP_NAME);
}

export function getSenatorsFilePath(): string {
  return path.join(getConfigDir(), "senators.json");
}

async function ensurePermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Some filesystems ignore chmod or restrict it. Persistence still works.
  }
}

async function ensureConfigDir(): Promise<void> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await ensurePermissions(configDir, 0o700);
}

export async function loadSenators(): Promise<SenatorConfig[]> {
  const filePath = getSenatorsFilePath();

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { senators?: SenatorConfigRecord[] };

    if (!Array.isArray(parsed.senators)) {
      return [];
    }

    return parsed.senators
      .filter(isLoadedSenatorRecord)
      .map((senator): SenatorConfig => ({
        id: senator.id,
        name: senator.name,
        provider: senator.provider,
        apiKey: senator.apiKey || undefined,
        apiKeyEnvVar: normalizeOptionalEnvVarName(senator.apiKeyEnvVar),
        modelId: senator.modelId || senator.model || "",
        baseUrl: senator.baseUrl || undefined,
        expertise: senator.expertise || undefined,
        active: typeof senator.active === "boolean" ? senator.active : undefined,
        createdAt: senator.createdAt,
      }));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }

    throw new Error(`Failed to read local configuration: ${nodeError.message}`);
  }
}

export async function saveSenators(senators: SenatorConfig[]): Promise<void> {
  await ensureConfigDir();

  const filePath = getSenatorsFilePath();
  const payload: SenatorsStore = {
    version: STORE_VERSION,
    senators: senators.map(normalizeSenatorForPersistence),
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await ensurePermissions(filePath, 0o600);
}

export async function clearSenators(): Promise<void> {
  await saveSenators([]);
}

export async function updateSenator(updatedSenator: SenatorConfig): Promise<SenatorConfig> {
  const senators = await loadSenators();
  const nextSenators = senators.map((senator) => (senator.id === updatedSenator.id ? updatedSenator : senator));
  await saveSenators(nextSenators);
  return updatedSenator;
}

export async function removeSenatorById(senatorId: string): Promise<boolean> {
  const senators = await loadSenators();
  const nextSenators = senators.filter((senator) => senator.id !== senatorId);

  if (nextSenators.length === senators.length) {
    return false;
  }

  await saveSenators(nextSenators);
  return true;
}

export async function addSenator(config: Omit<SenatorConfig, "id" | "createdAt">): Promise<SenatorConfig> {
  const senators = await loadSenators();
  const senator: SenatorConfig = {
    ...config,
    apiKey: config.apiKey || undefined,
    apiKeyEnvVar: normalizeOptionalEnvVarName(config.apiKeyEnvVar),
    baseUrl: config.baseUrl || undefined,
    expertise: config.expertise || undefined,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  senators.push(senator);
  await saveSenators(senators);

  return senator;
}

export async function listPresets(): Promise<string[]> {
  const config = await loadAppConfig();
  return config.presets ? Object.keys(config.presets) : [];
}

export async function loadPreset(name: string): Promise<string[] | null> {
  const config = await loadAppConfig();
  return config.presets?.[name] ?? null;
}

export async function savePreset(name: string, senatorIds: string[]): Promise<void> {
  const config = await loadAppConfig();
  if (!config.presets) config.presets = {};
  config.presets[name] = senatorIds;
  await saveAppConfig(config);
}

export async function deletePreset(name: string): Promise<boolean> {
  const config = await loadAppConfig();
  if (!config.presets?.[name]) return false;
  delete config.presets[name];
  await saveAppConfig(config);
  return true;
}

export async function setActiveSenators(activeIds: string[]): Promise<void> {
  const senators = await loadSenators();
  const idSet = new Set(activeIds);
  const updated = senators.map((s) => ({ ...s, active: idSet.has(s.id) }));
  await saveSenators(updated);
}

export async function activateAllSenators(): Promise<void> {
  const senators = await loadSenators();
  const updated = senators.map((s) => ({ ...s, active: undefined }));
  await saveSenators(updated);
}

// ─── Session persistence ────────────────────────────────────────────

export interface SessionTurn {
  userPrompt: string;
  consensusText: string;
  winnerId: string;
}

export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
}

function getSessionsDir(): string {
  return path.join(getConfigDir(), "sessions");
}

async function ensureSessionsDir(): Promise<void> {
  const dir = getSessionsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await ensurePermissions(dir, 0o700);
}

export function createSessionId(): string {
  return randomUUID();
}

export function createEmptySession(id: string): SessionData {
  const now = new Date().toISOString();
  return { id, createdAt: now, updatedAt: now, turns: [] };
}

export async function saveSession(session: SessionData): Promise<void> {
  await ensureSessionsDir();
  const filePath = path.join(getSessionsDir(), `${session.id}.json`);
  session.updatedAt = new Date().toISOString();
  await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await ensurePermissions(filePath, 0o600);
}

export async function loadSession(id: string): Promise<SessionData | null> {
  try {
    const raw = await readFile(path.join(getSessionsDir(), `${id}.json`), "utf8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  firstPrompt: string;
  turnCount: number;
}

export async function listRecentSessions(limit: number): Promise<SessionSummary[]> {
  const dir = getSessionsDir();
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = entries.filter((entry) => entry.endsWith(".json"));
  const summaries: SessionSummary[] = [];

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(path.join(dir, file), "utf8");
      const session = JSON.parse(raw) as SessionData;
      if (session.turns.length > 0) {
        summaries.push({
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          firstPrompt: session.turns[0].userPrompt,
          turnCount: session.turns.length,
        });
      }
    } catch {
      // Skip corrupt files.
    }
  }

  return summaries
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}

// ─── App config (config.json) ──────────��─────────────────────────────

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AppConfig {
  mcpServers?: Record<string, McpServerEntry>;
  presidentId?: string;
  presets?: Record<string, string[]>;
}

function getAppConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export async function loadAppConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(getAppConfigPath(), "utf8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return {};
  }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
  await ensureConfigDir();
  const filePath = getAppConfigPath();
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await ensurePermissions(filePath, 0o600);
}
