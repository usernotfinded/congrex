import type { Provider, SenatorConfig } from "./config.js";

export const providerEnvVarNames: Partial<Record<Provider, readonly string[]>> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  xai: ["XAI_API_KEY"],
};

export function resolveProviderEnvApiKey(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const envVarName of providerEnvVarNames[provider] ?? []) {
    const value = env[envVarName]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function resolveSenatorApiKey(
  senator: Pick<SenatorConfig, "provider" | "apiKey" | "apiKeyEnvVar">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromCustomEnv = senator.apiKeyEnvVar ? env[senator.apiKeyEnvVar]?.trim() : undefined;
  return fromCustomEnv || senator.apiKey?.trim() || resolveProviderEnvApiKey(senator.provider, env);
}
