/**
 * @module mcp
 *
 * Production-grade MCP (Model Context Protocol) integration for Congrex AI Senate.
 *
 * This module manages connections to external MCP tool servers and exposes their
 * safe, read-only tools to senators during debate rounds. Security is the primary
 * design concern: senators are untrusted LLMs, so only vetted tools are exposed.
 *
 * Architecture overview:
 *
 *   ┌─────────────┐     ┌───────────────────┐     ┌───────────────┐
 *   │  Senator LLM │────▶│    McpManager     │────▶│  MCP Server   │
 *   │  (untrusted) │     │ (filter + audit)  │     │  (trusted)    │
 *   └─────────────┘     └───────────────────┘     └───────────────┘
 *                          │                  ▲
 *                          │ blocklist        │ raw tools
 *                          │ desc scan        │
 *                          ▼                  │
 *                       safe tools only  ─────┘
 *
 * Key design decisions:
 *   1. Two-layer security filter (name tokens + description patterns)
 *   2. Timeouts on every external operation (connect, list, call)
 *   3. Tool result truncation to protect LLM context windows
 *   4. Structured audit trail for every tool invocation
 *   5. Graceful degradation — individual server failures never crash the debate
 *   6. Initialization lock — concurrent calls to initialize() are safe
 *   7. Stale tool cleanup — disconnected servers have their tools purged
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getConfigDir } from "./config.js";
import { sanitizeForDisplay } from "./sanitize.js";
import { APP_VERSION } from "./version.js";

// ═══════════════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════════════

// ─── Config (internal) ──────────────────────────────────────────────

/** Raw MCP server entry from ~/.config/congrex/config.json. */
interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Per-server tool allowlist. When present, only these exact tool names are
   * considered for exposure (they still must pass the blocklist). Useful when
   * a server provides many tools but you only want to expose a specific subset.
   */
  allowTools?: string[];
  /**
   * Per-server tool denylist. These tool names are always blocked regardless
   * of whether they pass generic safety filters. Takes precedence over
   * allowTools (a tool in both lists is blocked).
   */
  denyTools?: string[];
}

/** MCP-relevant subset of config.json. */
interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

// ─── Public types ───────────────────────────────────────────────────

/** Normalized, provider-agnostic representation of a single MCP tool. */
export interface McpTool {
  /** Name of the MCP server that provides this tool. */
  serverName: string;
  /** Tool identifier — unique across all connected servers after filtering. */
  name: string;
  /** Human-readable description of the tool's purpose. */
  description: string;
  /** JSON Schema describing the tool's accepted input parameters. */
  inputSchema: Record<string, unknown>;
}

/** OpenAI function-calling compatible tool definition. */
export interface OpenAiToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Anthropic tool-use compatible definition. */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Google Generative AI compatible tool definition. */
export interface GoogleToolDef {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

/** Structured record of a single tool invocation for diagnostics. */
export interface ToolCallAuditEntry {
  timestamp: string;
  toolName: string;
  serverName: string;
  durationMs: number;
  resultBytes: number;
  truncated: boolean;
  isError: boolean;
  error?: string;
}

/** Health snapshot for a single MCP server connection. */
export interface ServerHealth {
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
  toolCount: number;
}

// ═══════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Maximum tool-call → response round-trips per senator generation.
 * Prevents runaway tool loops from burning tokens and time.
 */
const MAX_TOOL_CALL_ROUNDS = 5;

/** Hard timeout for establishing an MCP server connection (ms). */
const CONNECTION_TIMEOUT_MS = 15_000;

/** Hard timeout for listing tools from a connected server (ms). */
const TOOL_LIST_TIMEOUT_MS = 10_000;

/** Hard timeout for a single tool call invocation (ms). */
const TOOL_CALL_TIMEOUT_MS = 30_000;

/**
 * Maximum byte length of a tool call result before truncation.
 * 64 KB is generous for read operations while protecting against
 * multi-megabyte dumps that would blow up LLM context windows.
 */
const MAX_TOOL_RESULT_BYTES = 64 * 1024;

/** Maximum audit log entries retained in memory (rolling). */
const MAX_AUDIT_ENTRIES = 200;

export { MAX_TOOL_CALL_ROUNDS };

// ═══════════════════════════════════════════════════════════════════════
//  TOOL FILTERING — Security Layer
// ═══════════════════════════════════════════════════════════════════════
//
// Congrex exposes MCP tools to senators during debate Round 1 (Answer round).
// Senators are UNTRUSTED LLMs that must NEVER write files, execute commands,
// delete data, or trigger any external side effects through MCP tools.
//
// Defense strategy (two independent layers):
//
//   Layer 1 — NAME TOKEN BLOCKLIST
//     Tool names are tokenized by splitting on camelCase, snake_case, and
//     kebab-case boundaries into individual words. If any word exactly matches
//     a blocked verb, the tool is rejected.
//
//     Why tokenize? Substring matching produces false positives:
//       "offset"  contains "set" → incorrectly blocked
//       "dataset" contains "set" → incorrectly blocked
//       "asset"   contains "set" → incorrectly blocked
//     Token matching fixes all of these because "offset" tokenizes to ["offset"],
//     not ["off", "set"]. Only true compound names like "setValue" → ["set", "value"]
//     are caught.
//
//   Layer 2 — DESCRIPTION PATTERN SCAN
//     Tool descriptions are scanned for phrases indicating mutation, deletion,
//     execution, or external side effects. This catches tools with innocuous
//     names but dangerous descriptions (e.g. a tool named "process_items"
//     whose description says "deletes expired records").
//
// Per-server escape hatches (allowTools / denyTools in config.json) let
// operators fine-tune filtering when the generic heuristics are wrong.

/**
 * Blocked verb tokens — a tool is rejected if ANY of its tokenized name
 * words exactly matches any entry here (case-insensitive after tokenization).
 * Organized by threat category.
 */
const BLOCKED_NAME_TOKENS: ReadonlySet<string> = new Set([
  // ── File / data mutation ──
  "write", "edit", "create", "update", "overwrite",
  "move", "rename", "copy", "append", "insert",
  "truncate", "mkdir", "mkdirs", "put", "patch", "set",
  "save", "store", "persist", "modify",
  // ── Deletion ──
  "delete", "remove", "rm", "rmdir", "drop",
  "purge", "wipe", "destroy", "clean", "clear", "unlink",
  // ── Code / command execution ──
  "run", "execute", "exec", "spawn", "bash", "cmd", "shell",
  "apply", "invoke", "eval", "call",
  // ── External side effects ──
  "push", "upload", "send", "post", "fork", "publish",
  "deploy", "install", "uninstall", "merge", "rebase", "commit",
  // ── Permission / process / system control ──
  "chmod", "chown", "chgrp", "kill", "stop", "halt",
  "format", "init", "reset", "restore",
]);

/**
 * Regex patterns matched against tool descriptions (case-insensitive).
 * If any pattern matches, the tool is rejected regardless of its name.
 * Patterns are intentionally conservative to minimize false positives on
 * descriptions — they require both a verb and a noun context.
 */
const BLOCKED_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  // Mutation verbs targeting files, data, records, etc.
  /\b(?:creates?|writes?|modif(?:y|ies)|edits?|updates?)\s+(?:\w+\s+)*(?:files?|data|records?|entries?|documents?|content)\b/i,
  // Deletion verbs (standalone — dangerous in any context).
  /\b(?:delet(?:e|es|ing)|remov(?:e|es|ing)|drops?|erases?)\b/i,
  // Execution verbs targeting commands, scripts, code.
  /\b(?:execut(?:e|es|ing)|runs?)\s+(?:\w+\s+)*(?:commands?|scripts?|code|programs?|binaries?)\b/i,
  // Sending / external communication.
  /\b(?:sends?\s+(?:\w+\s+)*(?:emails?|messages?|notifications?|requests?))\b/i,
  // Explicit "side effects" mention.
  /\bside[- ]?effects?\b/i,
  // Explicit mutation language.
  /\b(?:mutat(?:e|es|ing)|mutations?)\b/i,
];

// ═══════════════════════════════════════════════════════════════════════
//  ENVIRONMENT SANITIZATION
// ═══════════════════════════════════════════════════════════════════════
//
// [P1 FIX] MCP servers run as child processes and previously inherited the
// full parent environment via { ...process.env, ...config.env }. This leaked
// every API key, secret, and credential in the CLI process to any configured
// MCP server — including servers added via /mcp that may be untrusted.
//
// We now construct a minimal, curated environment containing only system
// variables needed for the server binary to function. Secrets like
// OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_*, DATABASE_URL, etc. are NEVER
// forwarded. Users can still pass specific env vars per-server via config.

/**
 * Environment variables safe to pass to MCP server child processes.
 * This list covers system identity, locale, PATH, runtime tools, TLS,
 * and proxies — but explicitly excludes all API keys and credentials.
 */
const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  // System identity
  "HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE",
  // Locale
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LANGUAGE",
  // Terminal
  "SHELL", "TERM", "COLORTERM",
  // Temp directories
  "TMPDIR", "TEMP", "TMP",
  // XDG directories
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME",
  // Executable search path (critical for finding binaries)
  "PATH",
  // Node.js (needed for npx-based MCP servers)
  "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS",
  "NVM_DIR", "NVM_BIN", "NVM_INC",
  "VOLTA_HOME",
  "npm_config_prefix", "npm_config_cache",
  // Python (for Python-based MCP servers)
  "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV",
  // Go / Rust (for compiled MCP servers)
  "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME",
  // TLS/SSL certificates
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  // Dynamic library paths
  "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",  // macOS
  "LD_LIBRARY_PATH",                                    // Linux
  // Proxy (servers behind corporate proxies need these)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
]);

/**
 * Builds a sanitized environment for an MCP server child process.
 * Only safe system variables are included from the parent process.
 * User-specified env vars from config are merged on top (the user
 * explicitly chose to pass those, so we respect that decision).
 */
function buildSanitizedEnv(configEnv?: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  // User-specified env vars override (explicitly configured = trusted).
  if (configEnv) {
    Object.assign(sanitized, configEnv);
  }
  return sanitized;
}

/**
 * Splits a tool name into semantic tokens by breaking on naming convention
 * boundaries: camelCase, PascalCase, snake_case, kebab-case, dot.separated.
 *
 * @example
 *   tokenizeToolName("readFile")       → ["read", "file"]
 *   tokenizeToolName("write_to_disk")  → ["write", "to", "disk"]
 *   tokenizeToolName("RunCommand")     → ["run", "command"]
 *   tokenizeToolName("fs.readdir")     → ["fs", "readdir"]
 *   tokenizeToolName("XMLParser")      → ["xml", "parser"]
 *   tokenizeToolName("offset")         → ["offset"]   (NOT ["off","set"])
 */
function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")      // camelCase → camel_Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")    // XMLParser → XML_Parser
    .toLowerCase()
    .split(/[_\-./\\]+/)
    .filter((token) => token.length > 0);
}

/** Result of running a tool through the safety filter. */
type FilterVerdict = { safe: true } | { safe: false; reason: string };

/**
 * Evaluates whether a tool is safe to expose to untrusted LLMs during debate.
 * Applies per-server overrides first, then the two generic filter layers.
 */
function evaluateToolSafety(
  toolName: string,
  description: string,
  serverConfig?: McpServerConfig,
): FilterVerdict {
  // Per-server denylist has absolute priority — always blocks.
  if (serverConfig?.denyTools?.includes(toolName)) {
    return { safe: false, reason: "explicitly denied in server config" };
  }

  // Per-server allowlist — if defined, only listed tools may pass
  // (but they still go through the generic blocklist below, so you
  // can't accidentally allowlist "bash").
  if (serverConfig?.allowTools && !serverConfig.allowTools.includes(toolName)) {
    return { safe: false, reason: "not in server allowlist" };
  }

  // Layer 1: Tokenized name blocklist.
  const tokens = tokenizeToolName(toolName);
  for (const token of tokens) {
    if (BLOCKED_NAME_TOKENS.has(token)) {
      return { safe: false, reason: `name token "${token}" is blocked` };
    }
  }

  // Layer 2: Description pattern scan.
  for (const pattern of BLOCKED_DESCRIPTION_PATTERNS) {
    if (pattern.test(description)) {
      return { safe: false, reason: "description matches dangerous pattern" };
    }
  }

  return { safe: true };
}

// ═══════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Wraps a promise with a hard timeout. If the promise doesn't settle
 * within `ms` milliseconds, it rejects with a descriptive error.
 * The original promise is NOT cancelled (no native way in JS), but its
 * result is ignored after timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Truncates a string to fit within `maxBytes` (UTF-8 aware).
 * Appends a truncation notice if content was shortened so the LLM
 * knows it's seeing partial output.
 */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);

  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }

  // Decode the truncated bytes — TextDecoder handles partial UTF-8 gracefully.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const shortened = decoder.decode(encoded.slice(0, maxBytes));
  const notice = `\n\n[Truncated: ${encoded.length.toLocaleString()} bytes → ${maxBytes.toLocaleString()} bytes]`;
  return { text: shortened + notice, truncated: true };
}

/**
 * Extracts human-readable text from an MCP tool call result.
 * Handles text blocks, images (returns placeholder), embedded resources,
 * and unknown content types (serialized as JSON for transparency).
 */
function extractTextFromResult(result: unknown): string {
  const content = (result as { content?: unknown[] })?.content;
  if (!Array.isArray(content)) {
    return JSON.stringify(result);
  }

  const parts: string[] = [];

  for (const block of content) {
    const typed = block as { type?: string; text?: string };
    switch (typed.type) {
      case "text":
        if (typed.text) parts.push(typed.text);
        break;
      case "image":
        // Images can't be forwarded to text-only LLM contexts.
        parts.push("[Image content omitted from tool result]");
        break;
      case "resource":
        parts.push("[Embedded resource omitted from tool result]");
        break;
      default:
        // Unknown content type — serialize for transparency.
        parts.push(JSON.stringify(block));
    }
  }

  return parts.join("\n") || JSON.stringify(content);
}

// ═══════════════════════════════════════════════════════════════════════
//  TOOL APPROVAL FINGERPRINTING
// ═══════════════════════════════════════════════════════════════════════
//
// Approvals must bind to the *full identity* of a tool — not just its name.
// A server can change a tool's description or input schema while keeping
// the same name, and a name-only approval cache would silently reuse the
// stale approval. We compute a SHA-256 fingerprint over a deterministic
// serialization of (serverName, toolName, description, inputSchema). Any
// mutation in any of those fields produces a new fingerprint, forcing the
// user to re-approve.

/**
 * Produces a deterministic JSON string from an arbitrary value.
 * Object keys are sorted recursively so output is stable regardless of
 * insertion order. This is critical for fingerprint consistency — two
 * schemas `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` must produce the
 * same serialization.
 */
export function deterministicJsonStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(deterministicJsonStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + deterministicJsonStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Computes a stable approval fingerprint for an MCP tool.
 * Binds the approval to the tool's full identity — server origin, name,
 * description, and input schema. Any change in any field invalidates
 * the previous approval and forces re-prompting.
 *
 * Format: SHA-256 hex digest of the deterministic JSON serialization of
 * `{ description, inputSchema, name, serverName }` (sorted keys).
 */
export function getMcpToolFingerprint(tool: McpTool): string {
  const payload = deterministicJsonStringify({
    serverName: tool.serverName,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════
//  McpManager
// ═══════════════════════════════════════════════════════════════════════

export class McpManager {
  // ── Internal state ────────────────────────────────────────────────
  private clients = new Map<string, Client>();
  private transports = new Map<string, StdioClientTransport>();
  private toolIndex = new Map<string, string>();          // toolName → serverName
  private cachedTools: McpTool[] = [];
  private serverConfigs = new Map<string, McpServerConfig>();
  private healthMap = new Map<string, ServerHealth>();
  private auditLog: ToolCallAuditEntry[] = [];
  private initialized = false;
  private initLock: Promise<void> | null = null;

  /**
   * [P1 FIX] Optional callback invoked before every tool call.
   * Set this to log tool calls visibly in the terminal during debate rounds.
   * Provides transparency into what tools are being called without blocking execution.
   */
  onBeforeToolCall: ((toolName: string, serverName: string) => void) | null = null;

  // ═════════════════════════════════════════════════════════════════
  //  PUBLIC API — keep stable for index.ts compatibility
  // ═════════════════════════════════════════════════════════════════

  /**
   * Reads config.json, connects to all configured MCP servers, and builds
   * the filtered tool index. Idempotent — call shutdown() first to reload.
   *
   * Connection errors are logged but never propagated; the manager starts
   * in a degraded state with whatever servers succeeded.
   */
  async initialize(): Promise<void> {
    // Prevent concurrent initialization races (e.g. two rapid shutdown+init cycles).
    if (this.initLock) return this.initLock;
    if (this.initialized) return;

    this.initLock = this.performInitialization();
    try {
      await this.initLock;
    } finally {
      this.initLock = null;
    }
  }

  /** All currently available (safe, filtered) MCP tools. */
  get tools(): readonly McpTool[] {
    return this.cachedTools;
  }

  /** Whether any safe tools are available for senators to use. */
  get hasTools(): boolean {
    return this.cachedTools.length > 0;
  }

  /**
   * Invokes a tool by name, forwarding arguments to the owning MCP server.
   *
   * Returns the tool's text output as a string. On failure, returns a
   * JSON-serialized `{ error: string }` — the caller passes this back to
   * the LLM as a tool result so the model can react to the failure.
   *
   * Security: only tools that passed the safety filter during discovery
   * exist in the tool index. A call with a blocked tool name gets
   * "Unknown tool" — the LLM never learns about blocked tools.
   *
   * Results exceeding MAX_TOOL_RESULT_BYTES are truncated with a notice.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const serverName = this.toolIndex.get(toolName);
    if (!serverName) {
      return JSON.stringify({ error: `Unknown tool: "${toolName}"` });
    }

    const client = this.clients.get(serverName);
    if (!client) {
      // Server disconnected since tool discovery — purge stale references
      // so subsequent calls don't keep hitting this path.
      this.purgeServerTools(serverName);
      return JSON.stringify({ error: `Server "${serverName}" is no longer connected` });
    }

    // [P1 FIX] Notify caller of every tool call for transparency/logging.
    this.onBeforeToolCall?.(toolName, serverName);

    const startMs = Date.now();
    let resultText: string;
    let truncated = false;
    let isError = false;

    try {
      const rawResult = await withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        TOOL_CALL_TIMEOUT_MS,
        `Tool call "${toolName}"`,
      );

      // Check MCP-level tool error flag.
      isError = Boolean((rawResult as { isError?: boolean }).isError);

      resultText = extractTextFromResult(rawResult);

      // Enforce size limit to protect downstream LLM context windows.
      const bounded = truncateToBytes(resultText, MAX_TOOL_RESULT_BYTES);
      resultText = bounded.text;
      truncated = bounded.truncated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordAudit(toolName, serverName, Date.now() - startMs, 0, false, true, message);
      this.trackServerError(serverName, message);
      return JSON.stringify({ error: message });
    }

    this.recordAudit(
      toolName,
      serverName,
      Date.now() - startMs,
      new TextEncoder().encode(resultText).length,
      truncated,
      isError,
    );

    return resultText;
  }

  // ─── Provider format converters ───────────────────────────────

  /** Converts safe tools to OpenAI function-calling format. */
  toOpenAiTools(): OpenAiToolDef[] {
    return this.cachedTools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /** Converts safe tools to Anthropic tool-use format. */
  toAnthropicTools(): AnthropicToolDef[] {
    return this.cachedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /** Converts safe tools to Google Generative AI format. */
  toGoogleTools(): GoogleToolDef[] {
    if (this.cachedTools.length === 0) return [];

    return [{
      functionDeclarations: this.cachedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    }];
  }

  // ─── Tool approval (P1 fix) ────────────────────────────────────

  /**
   * [P1 FIX] Disables all MCP tools for this session. Called when the user
   * declines the tool approval prompt at startup. Tools can only be
   * re-enabled by shutdown() + initialize() + re-approval.
   */
  disableAllTools(): void {
    this.cachedTools = [];
    this.toolIndex.clear();
  }

  /**
   * [P1 FIX] Restricts the available tool set to only the specified names.
   * Called after the user selects which tools to approve for this session.
   */
  restrictToTools(approvedNames: ReadonlySet<string>): void {
    this.cachedTools = this.cachedTools.filter((t) => approvedNames.has(t.name));
    this.toolIndex.clear();
    for (const tool of this.cachedTools) {
      this.toolIndex.set(tool.name, tool.serverName);
    }
  }

  // ─── Diagnostics (new, non-breaking) ──────────────────────────

  /** Returns a read-only snapshot of per-server health metrics. */
  getServerHealth(): ReadonlyMap<string, Readonly<ServerHealth>> {
    return this.healthMap;
  }

  /** Returns the N most recent audit entries (newest first). */
  getRecentAudit(limit = 20): readonly ToolCallAuditEntry[] {
    return this.auditLog.slice(-limit).reverse();
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Disconnects all MCP servers and clears cached state. After shutdown(),
   * initialize() can be called again to reconnect (used after add/remove server).
   * Audit log is preserved across reinitializations for session-wide diagnostics.
   */
  async shutdown(): Promise<void> {
    // Snapshot entries before clearing the map to avoid mutation during iteration.
    const entries = Array.from(this.clients.entries());

    // Close all clients concurrently — best-effort, errors are logged.
    await Promise.allSettled(
      entries.map(async ([name, client]) => {
        try {
          await client.close();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`MCP: error closing "${sanitizeForDisplay(name)}": ${sanitizeForDisplay(msg)}`);
        }
      }),
    );

    this.clients.clear();
    this.transports.clear();
    this.toolIndex.clear();
    this.cachedTools = [];
    this.serverConfigs.clear();
    this.healthMap.clear();
    // NOTE: auditLog is intentionally NOT cleared — it spans the session.
    this.initialized = false;
  }

  // ═════════════════════════════════════════════════════════════════
  //  PRIVATE IMPLEMENTATION
  // ═════════════════════════════════════════════════════════════════

  private async performInitialization(): Promise<void> {
    const configPath = path.join(getConfigDir(), "config.json");
    let config: McpConfigFile;

    try {
      const raw = await readFile(configPath, "utf8");
      config = JSON.parse(raw) as McpConfigFile;
    } catch {
      // No config file or invalid JSON — operate without MCP tools.
      this.initialized = true;
      return;
    }

    const servers = config.mcpServers;
    if (!servers || typeof servers !== "object") {
      this.initialized = true;
      return;
    }

    // Connect to all servers concurrently. Individual failures are isolated
    // and logged — the manager starts with whatever servers responded.
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(async ([name, serverConfig]) => {
        this.validateServerConfig(name, serverConfig);
        this.serverConfigs.set(name, serverConfig);
        await this.connectServer(name, serverConfig);
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        const name = entries[i][0];
        const message = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        console.error(`MCP: failed to connect to "${sanitizeForDisplay(name)}": ${sanitizeForDisplay(message)}`);
        this.trackServerError(name, message);
      }
    }

    await this.refreshTools();
    this.initialized = true;
  }

  // ─── Connection ───────────────────────────────────────────────

  /**
   * Validates a server config entry before attempting connection.
   * Throws a descriptive error for malformed entries so operators
   * get clear feedback instead of cryptic spawn failures.
   */
  private validateServerConfig(name: string, config: McpServerConfig): void {
    if (!config.command || typeof config.command !== "string") {
      throw new Error(`Server "${name}": missing or invalid "command" field`);
    }
    if (config.args !== undefined && !Array.isArray(config.args)) {
      throw new Error(`Server "${name}": "args" must be an array`);
    }
    if (config.env !== undefined && (typeof config.env !== "object" || config.env === null)) {
      throw new Error(`Server "${name}": "env" must be an object`);
    }
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    // [P1 FIX] Always use a sanitized environment. Never inherit the full
    // process.env — it contains API keys and secrets that MCP servers must not see.
    // Trust boundary: config.command is executed as trusted local code. Tool
    // approval filters later LLM tool use; it is not a process-start approval.
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: buildSanitizedEnv(config.env),
    });

    const client = new Client({ name: `congrex-${name}`, version: APP_VERSION });

    // Hard timeout prevents a hung server binary from blocking startup.
    await withTimeout(
      client.connect(transport),
      CONNECTION_TIMEOUT_MS,
      `Connection to MCP server "${name}"`,
    );

    this.clients.set(name, client);
    this.transports.set(name, transport);
  }

  // ─── Tool discovery & filtering ───────────────────────────────

  /**
   * Queries all connected servers for their tool lists, applies the
   * two-layer safety filter, resolves name collisions, and builds
   * the cached tool index.
   */
  private async refreshTools(): Promise<void> {
    this.cachedTools = [];
    this.toolIndex.clear();

    for (const [serverName, client] of this.clients) {
      try {
        const result = await withTimeout(
          client.listTools(),
          TOOL_LIST_TIMEOUT_MS,
          `Tool listing from "${serverName}"`,
        );

        let accepted = 0;
        let blocked = 0;
        const serverConfig = this.serverConfigs.get(serverName);

        for (const tool of result.tools) {
          // ── Security filter ──
          const verdict = evaluateToolSafety(
            tool.name,
            tool.description || "",
            serverConfig,
          );

          if (!verdict.safe) {
            blocked++;
            continue;
          }

          // ── Name collision guard ──
          // First server to register a name wins. Duplicates are skipped
          // with a visible warning so operators know to namespace their tools.
          if (this.toolIndex.has(tool.name)) {
            const owner = this.toolIndex.get(tool.name)!;
            console.error(
              `MCP: tool name collision — "${sanitizeForDisplay(tool.name)}" from "${sanitizeForDisplay(serverName)}" ` +
              `conflicts with "${sanitizeForDisplay(owner)}"; skipping duplicate`,
            );
            continue;
          }

          this.cachedTools.push({
            serverName,
            name: tool.name,
            description: tool.description || "",
            inputSchema: (tool.inputSchema as Record<string, unknown>) || {
              type: "object",
              properties: {},
            },
          });
          this.toolIndex.set(tool.name, serverName);
          accepted++;
        }

        // Record healthy state for this server.
        this.healthMap.set(serverName, {
          consecutiveFailures: 0,
          toolCount: accepted,
        });

        if (blocked > 0) {
          console.error(
            `MCP: "${sanitizeForDisplay(serverName)}" — ${accepted} tool(s) available, ` +
            `${blocked} blocked by safety filter`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`MCP: failed to list tools from "${sanitizeForDisplay(serverName)}": ${sanitizeForDisplay(message)}`);
        this.trackServerError(serverName, message);
      }
    }
  }

  // ─── Stale tool cleanup ───────────────────────────────────────

  /**
   * Removes all tools belonging to a disconnected server from the
   * cached index, preventing repeated failed calls.
   */
  private purgeServerTools(serverName: string): void {
    this.cachedTools = this.cachedTools.filter((t) => t.serverName !== serverName);

    for (const [toolName, owner] of this.toolIndex) {
      if (owner === serverName) {
        this.toolIndex.delete(toolName);
      }
    }
  }

  // ─── Audit & health tracking ──────────────────────────────────

  private recordAudit(
    toolName: string,
    serverName: string,
    durationMs: number,
    resultBytes: number,
    truncated: boolean,
    isError: boolean,
    error?: string,
  ): void {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      toolName,
      serverName,
      durationMs,
      resultBytes,
      truncated,
      isError,
      error,
    });

    // Rolling window — prevent unbounded memory growth during long sessions.
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_ENTRIES);
    }
  }

  private trackServerError(serverName: string, message: string): void {
    const existing = this.healthMap.get(serverName) || {
      consecutiveFailures: 0,
      toolCount: 0,
    };
    this.healthMap.set(serverName, {
      ...existing,
      consecutiveFailures: existing.consecutiveFailures + 1,
      lastError: message,
      lastErrorAt: new Date().toISOString(),
    });
  }
}
