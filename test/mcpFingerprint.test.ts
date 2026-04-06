import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicJsonStringify,
  getMcpToolFingerprint,
  type McpTool,
} from "../src/mcp.js";

// ═══════════════════════════════════════════════════════════════════════
//  deterministicJsonStringify
// ═══════════════════════════════════════════════════════════════════════

test("deterministicJsonStringify sorts object keys recursively", () => {
  const a = deterministicJsonStringify({ z: 1, a: 2, m: { c: 3, b: 4 } });
  const b = deterministicJsonStringify({ a: 2, m: { b: 4, c: 3 }, z: 1 });
  assert.equal(a, b);
});

test("deterministicJsonStringify handles arrays, nulls, and primitives", () => {
  assert.equal(deterministicJsonStringify(null), "null");
  // undefined has no JSON representation — canonicalized to "null" for consistency.
  assert.equal(deterministicJsonStringify(undefined), "null");
  assert.equal(deterministicJsonStringify(42), "42");
  assert.equal(deterministicJsonStringify("hello"), '"hello"');
  assert.equal(deterministicJsonStringify(true), "true");
  assert.equal(deterministicJsonStringify([3, 1, 2]), "[3,1,2]");
});

test("deterministicJsonStringify handles deeply nested objects", () => {
  const a = deterministicJsonStringify({
    outer: { middle: { inner: { z: 1, a: 2 } } },
  });
  const b = deterministicJsonStringify({
    outer: { middle: { inner: { a: 2, z: 1 } } },
  });
  assert.equal(a, b);
});

// ═══════════════════════════════════════════════════════════════════════
//  getMcpToolFingerprint
// ═══════════════════════════════════════════════════════════════════════

function makeTool(overrides?: Partial<McpTool>): McpTool {
  return {
    serverName: "test-server",
    name: "readItems",
    description: "Reads items from the database",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    ...overrides,
  };
}

function detectNewTools(
  tools: readonly McpTool[],
  approvedFingerprints: ReadonlySet<string>,
): McpTool[] {
  return tools.filter((tool) => !approvedFingerprints.has(getMcpToolFingerprint(tool)));
}

test("same tool identity produces the same fingerprint", () => {
  const a = getMcpToolFingerprint(makeTool());
  const b = getMcpToolFingerprint(makeTool());
  assert.equal(a, b);
});

test("fingerprint is a 64-character hex string (SHA-256)", () => {
  const fp = getMcpToolFingerprint(makeTool());
  assert.match(fp, /^[0-9a-f]{64}$/);
});

test("changed description produces a different fingerprint", () => {
  const original = getMcpToolFingerprint(makeTool());
  const changed = getMcpToolFingerprint(
    makeTool({ description: "Reads items from the cache" }),
  );
  assert.notEqual(original, changed);
});

test("changed input schema produces a different fingerprint", () => {
  const original = getMcpToolFingerprint(makeTool());
  const changed = getMcpToolFingerprint(
    makeTool({
      inputSchema: {
        type: "object",
        properties: { limit: { type: "string" } },
      },
    }),
  );
  assert.notEqual(original, changed);
});

test("changed server name produces a different fingerprint", () => {
  const original = getMcpToolFingerprint(makeTool());
  const changed = getMcpToolFingerprint(
    makeTool({ serverName: "other-server" }),
  );
  assert.notEqual(original, changed);
});

test("changed tool name produces a different fingerprint", () => {
  const original = getMcpToolFingerprint(makeTool());
  const changed = getMcpToolFingerprint(makeTool({ name: "readStuff" }));
  assert.notEqual(original, changed);
});

test("schema key insertion order does not affect fingerprint", () => {
  const a = getMcpToolFingerprint(
    makeTool({
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" }, offset: { type: "number" } },
      },
    }),
  );
  const b = getMcpToolFingerprint(
    makeTool({
      inputSchema: {
        properties: { offset: { type: "number" }, limit: { type: "number" } },
        type: "object",
      },
    }),
  );
  assert.equal(a, b);
});

test("adding a new schema property produces a different fingerprint", () => {
  const original = getMcpToolFingerprint(makeTool());
  const changed = getMcpToolFingerprint(
    makeTool({
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          format: { type: "string" },
        },
      },
    }),
  );
  assert.notEqual(original, changed);
});

test("new-tool detection does not re-prompt for unchanged approved tools", () => {
  const tool = makeTool();
  const approvedFingerprints = new Set([getMcpToolFingerprint(tool)]);

  assert.deepEqual(detectNewTools([tool], approvedFingerprints), []);
});

test("new-tool detection treats changed semantics as new even when the name matches", () => {
  const approvedTool = makeTool();
  const changedTool = makeTool({
    description: "Reads cached items from the database",
  });
  const approvedFingerprints = new Set([getMcpToolFingerprint(approvedTool)]);

  assert.deepEqual(detectNewTools([changedTool], approvedFingerprints), [changedTool]);
});

// ═══════════════════════════════════════════════════════════════════════
//  Disabled-mode memory: mcpDisabledSeenFingerprints
// ═══════════════════════════════════════════════════════════════════════
//
// When the user disables MCP, the runtime snapshots the current tool
// fingerprints into a separate "disabled seen" set. The disabled-state
// check compares against this set — NOT against mcpApprovedFingerprints
// (which is empty in disabled mode). This prevents both:
//   • treating every existing tool as "new" on every gate call
//   • silently ignoring genuinely new tools from a newly added server

test("disabled state with unchanged tool set does not trigger re-prompt", () => {
  // Simulates: user disables MCP when tools [A, B] exist.
  // On the next gate call the same tools [A, B] are discovered.
  // Detection should find zero new tools → no re-prompt.
  const toolA = makeTool({ name: "toolA" });
  const toolB = makeTool({ name: "toolB", serverName: "server-two" });

  // Snapshot taken at disable time — contains both fingerprints.
  const disabledSeen = new Set([
    getMcpToolFingerprint(toolA),
    getMcpToolFingerprint(toolB),
  ]);

  const newTools = detectNewTools([toolA, toolB], disabledSeen);
  assert.equal(newTools.length, 0, "same tool set should not trigger a prompt");
});

test("disabled state detects genuinely new tool from added server", () => {
  // Simulates: user disabled MCP when only [A] existed.
  // A new server is added, providing tool [B].
  // Detection should flag [B] as new.
  const toolA = makeTool({ name: "toolA" });
  const toolB = makeTool({
    serverName: "newly-added-server",
    name: "listProjects",
    description: "Lists all projects in the workspace",
  });

  const disabledSeen = new Set([getMcpToolFingerprint(toolA)]);

  const newTools = detectNewTools([toolA, toolB], disabledSeen);
  assert.equal(newTools.length, 1, "new tool must be detected");
  assert.equal(newTools[0].name, "listProjects");
});

test("disabled state after user declines review: same tools do not re-prompt", () => {
  // Simulates: user was prompted about [B] and declined.
  // The disabled-seen set is updated to include [A, B].
  // On the next gate call with [A, B], zero new tools → no re-prompt.
  const toolA = makeTool({ name: "toolA" });
  const toolB = makeTool({ name: "listProjects", serverName: "new-server" });

  // After declining, the seen set is updated to include both.
  const updatedDisabledSeen = new Set([
    getMcpToolFingerprint(toolA),
    getMcpToolFingerprint(toolB),
  ]);

  const newTools = detectNewTools([toolA, toolB], updatedDisabledSeen);
  assert.equal(newTools.length, 0, "declined tools should not trigger repeated prompts");
});

test("disabled state after user accepts review: approved tools are not flagged again", () => {
  // Simulates: user accepted review, approved tool A.
  // On the next gate call (now in "all"/"selected" mode), tool A should
  // not be flagged as new since its fingerprint is in the approved set.
  const toolA = makeTool({ name: "toolA" });
  const reApproved = new Set([getMcpToolFingerprint(toolA)]);

  assert.deepEqual(detectNewTools([toolA], reApproved), []);
});
