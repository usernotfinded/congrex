import type { Provider } from "./config.js";

export const DEBATE_MIN_ACTIVE_SENATORS = 2;
export const MISSING_SENATE_PRESIDENT_MESSAGE =
  "You must designate a Senate President (boss) before starting a debate. Please select one now.";
export const TOO_FEW_ACTIVE_SENATORS_MESSAGE =
  "The Senate requires at least 2 active AI models to debate. Use '/add' or '/preset' to continue.";
export const MCP_DISABLED_HOSTED_PROVIDER_MESSAGE =
  "MCP tools disabled for this debate: one or more senators use a hosted provider. " +
  "MCP tools are only available when all participating senators use a local provider.";
export const MCP_TOOL_USE_REJECTED_MESSAGE =
  "Provider requested MCP tool use when MCP tools were not exposed for this debate turn. " +
  "Rejecting response to avoid forwarding MCP tool results.";

/**
 * Hosted providers send requests to third-party API endpoints. MCP tool
 * definitions and results must never be forwarded to these providers because
 * read-only MCP tools could become data-exfiltration primitives.
 */
const HOSTED_PROVIDERS: ReadonlySet<Provider> = new Set([
  "openai",
  "anthropic",
  "google",
  "xai",
  "custom",
]);

type ActiveSenatorRef = {
  id: string;
};

export function hasDesignatedPresident(
  activeSenators: readonly ActiveSenatorRef[],
  presidentId?: string,
): boolean {
  return Boolean(presidentId && activeSenators.some((senator) => senator.id === presidentId));
}

export function getDebateStartBlockReason(
  activeSenators: readonly ActiveSenatorRef[],
  presidentId?: string,
): string | null {
  if (activeSenators.length < DEBATE_MIN_ACTIVE_SENATORS) {
    return TOO_FEW_ACTIVE_SENATORS_MESSAGE;
  }

  if (!hasDesignatedPresident(activeSenators, presidentId)) {
    return MISSING_SENATE_PRESIDENT_MESSAGE;
  }

  return null;
}

/**
 * Returns true when any participating senator uses a hosted (non-local)
 * provider. In that case MCP tools must NOT be exposed during the debate
 * to prevent data exfiltration through tool definitions or results.
 */
export function hasHostedProvider(
  senators: readonly { provider: Provider }[],
): boolean {
  return senators.some((s) => HOSTED_PROVIDERS.has(s.provider));
}

/**
 * MCP is only safe in debate when every participating senator is local.
 * Mixed or fully hosted chambers must not receive MCP tool definitions.
 */
export function canUseMcpToolsForDebate(
  senators: readonly { provider: Provider }[],
): boolean {
  return !hasHostedProvider(senators);
}

/**
 * Tool definitions and tool results must stay in lockstep: if tools were not
 * exposed for this exact provider turn, any returned tool-use block must be
 * rejected instead of executed.
 */
export function canUseMcpToolsForProviderTurn(
  allowMcpToolsForDebate: boolean,
  hasApprovedMcpTools: boolean,
  round: number,
  maxToolCallRounds: number,
): boolean {
  return allowMcpToolsForDebate && hasApprovedMcpTools && round < maxToolCallRounds;
}
