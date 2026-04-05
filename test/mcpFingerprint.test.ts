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
