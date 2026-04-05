import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseMcpToolsForDebate,
  canUseMcpToolsForProviderTurn,
  getDebateStartBlockReason,
  hasDesignatedPresident,
  hasHostedProvider,
  MCP_DISABLED_HOSTED_PROVIDER_MESSAGE,
  MCP_TOOL_USE_REJECTED_MESSAGE,
  MISSING_SENATE_PRESIDENT_MESSAGE,
  TOO_FEW_ACTIVE_SENATORS_MESSAGE,
} from "../src/debateGate.js";
import type { Provider } from "../src/config.js";

function activeSenator(id: string): { id: string } {
  return { id };
}

function senatorWithProvider(provider: Provider): { provider: Provider } {
  return { provider };
}

test("debate start is blocked when fewer than two active senators exist", () => {
  assert.equal(
    getDebateStartBlockReason([activeSenator("senator-1")], "senator-1"),
    TOO_FEW_ACTIVE_SENATORS_MESSAGE,
  );
});

test("debate start is blocked when no valid Senate President is designated", () => {
  const activeSenators = [activeSenator("senator-1"), activeSenator("senator-2")];

  assert.equal(hasDesignatedPresident(activeSenators, undefined), false);
  assert.equal(hasDesignatedPresident(activeSenators, "missing-president"), false);
  assert.equal(
    getDebateStartBlockReason(activeSenators, undefined),
    MISSING_SENATE_PRESIDENT_MESSAGE,
  );
  assert.equal(
    getDebateStartBlockReason(activeSenators, "missing-president"),
    MISSING_SENATE_PRESIDENT_MESSAGE,
  );
});

test("debate start is allowed only when the President is one of the active senators", () => {
  const activeSenators = [activeSenator("senator-1"), activeSenator("senator-2")];

  assert.equal(hasDesignatedPresident(activeSenators, "senator-2"), true);
  assert.equal(getDebateStartBlockReason(activeSenators, "senator-2"), null);
});

// ── MCP hosted-provider gating ──────────────────────────────────────

test("hasHostedProvider returns true for openai senators", () => {
  assert.equal(hasHostedProvider([senatorWithProvider("openai")]), true);
});

test("hasHostedProvider returns true for anthropic senators", () => {
  assert.equal(hasHostedProvider([senatorWithProvider("anthropic")]), true);
});

test("hasHostedProvider returns true for google senators", () => {
  assert.equal(hasHostedProvider([senatorWithProvider("google")]), true);
});

test("hasHostedProvider returns true for xai senators", () => {
  assert.equal(hasHostedProvider([senatorWithProvider("xai")]), true);
});

test("hasHostedProvider returns true for custom senators", () => {
  assert.equal(hasHostedProvider([senatorWithProvider("custom")]), true);
});

test("hasHostedProvider returns false when all senators are local", () => {
  assert.equal(
    hasHostedProvider([senatorWithProvider("local"), senatorWithProvider("local")]),
    false,
  );
});

test("hasHostedProvider returns true for mixed local + hosted chambers", () => {
  assert.equal(
    hasHostedProvider([senatorWithProvider("local"), senatorWithProvider("openai")]),
    true,
  );
});

test("hasHostedProvider returns false for empty senator list", () => {
  assert.equal(hasHostedProvider([]), false);
});

test("canUseMcpToolsForDebate returns true only for fully local chambers", () => {
  assert.equal(
    canUseMcpToolsForDebate([senatorWithProvider("local"), senatorWithProvider("local")]),
    true,
  );
  assert.equal(
    canUseMcpToolsForDebate([senatorWithProvider("local"), senatorWithProvider("openai")]),
    false,
  );
});

test("canUseMcpToolsForProviderTurn requires debate approval, available tools, and remaining rounds", () => {
  assert.equal(canUseMcpToolsForProviderTurn(true, true, 0, 5), true);
  assert.equal(canUseMcpToolsForProviderTurn(false, true, 0, 5), false);
  assert.equal(canUseMcpToolsForProviderTurn(true, false, 0, 5), false);
  assert.equal(canUseMcpToolsForProviderTurn(true, true, 5, 5), false);
});

test("MCP_DISABLED_HOSTED_PROVIDER_MESSAGE is a non-empty string", () => {
  assert.equal(typeof MCP_DISABLED_HOSTED_PROVIDER_MESSAGE, "string");
  assert.ok(MCP_DISABLED_HOSTED_PROVIDER_MESSAGE.length > 0);
});

test("MCP_TOOL_USE_REJECTED_MESSAGE is a non-empty string", () => {
  assert.equal(typeof MCP_TOOL_USE_REJECTED_MESSAGE, "string");
  assert.ok(MCP_TOOL_USE_REJECTED_MESSAGE.length > 0);
});
