import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForDisplay } from "../src/sanitize.js";

// ═══════════════════════════════════════════════════════════════════════
//  Plain strings pass through unchanged
// ═══════════════════════════════════════════════════════════════════════

test("plain ASCII string passes through unchanged", () => {
  assert.equal(sanitizeForDisplay("hello world"), "hello world");
});

test("string with tabs and newlines passes through unchanged", () => {
  assert.equal(sanitizeForDisplay("line1\n\tline2"), "line1\n\tline2");
});

test("unicode text passes through unchanged", () => {
  assert.equal(sanitizeForDisplay("Olá, Münch 🌍"), "Olá, Münch 🌍");
});

// ═══════════════════════════════════════════════════════════════════════
//  ANSI CSI sequences are stripped
// ═══════════════════════════════════════════════════════════════════════

test("strips CSI color codes (SGR)", () => {
  assert.equal(sanitizeForDisplay("\x1b[31mred text\x1b[0m"), "red text");
});

test("strips CSI cursor movement", () => {
  assert.equal(sanitizeForDisplay("\x1b[2J\x1b[H"), "");
});

test("strips CSI with multiple parameters", () => {
  assert.equal(sanitizeForDisplay("\x1b[1;31;42m styled \x1b[0m"), " styled ");
});

// ═══════════════════════════════════════════════════════════════════════
//  OSC sequences are stripped
// ═══════════════════════════════════════════════════════════════════════

test("strips OSC terminated by BEL", () => {
  // OSC to set terminal title
  assert.equal(sanitizeForDisplay("\x1b]0;evil title\x07safe"), "safe");
});

test("strips OSC terminated by ST (ESC backslash)", () => {
  assert.equal(sanitizeForDisplay("\x1b]8;;https://evil.com\x1b\\click\x1b]8;;\x1b\\"), "click");
});

// ═══════════════════════════════════════════════════════════════════════
//  Control characters are stripped
// ═══════════════════════════════════════════════════════════════════════

test("strips NUL, BEL, BS, and other C0 controls", () => {
  assert.equal(sanitizeForDisplay("a\x00b\x07c\x08d"), "abcd");
});

test("strips vertical tab and form feed", () => {
  assert.equal(sanitizeForDisplay("a\x0Bb\x0Cc"), "abc");
});

test("strips DEL character", () => {
  assert.equal(sanitizeForDisplay("abc\x7Fdef"), "abcdef");
});

test("strips C1 control characters (U+0080-U+009F)", () => {
  assert.equal(sanitizeForDisplay("a\u0080b\u009Fc"), "abc");
});

// ═══════════════════════════════════════════════════════════════════════
//  BiDi override characters are stripped
// ═══════════════════════════════════════════════════════════════════════

test("strips LRM and RLM", () => {
  assert.equal(sanitizeForDisplay("abc\u200Edef\u200Fghi"), "abcdefghi");
});

test("strips BiDi embedding/override (U+202A-U+202E)", () => {
  const bidi = "\u202Ahello\u202E";
  assert.equal(sanitizeForDisplay(bidi), "hello");
});

test("strips BiDi isolate characters (U+2066-U+2069)", () => {
  const isolate = "\u2066safe\u2069";
  assert.equal(sanitizeForDisplay(isolate), "safe");
});

// ═══════════════════════════════════════════════════════════════════════
//  Realistic malicious inputs
// ═══════════════════════════════════════════════════════════════════════

test("sanitizes malicious tool name that clears terminal", () => {
  // ESC[2J clears the screen, ESC[H moves cursor to home
  const malicious = "readFile\x1b[2J\x1b[H";
  assert.equal(sanitizeForDisplay(malicious), "readFile");
});

test("sanitizes tool name with embedded hyperlink OSC", () => {
  // OSC 8 hyperlink attack
  const malicious = "\x1b]8;;https://evil.com\x07clickme\x1b]8;;\x07";
  assert.equal(sanitizeForDisplay(malicious), "clickme");
});

test("sanitizes server name with BiDi + ANSI combo", () => {
  const malicious = "\u202Eevil-server\x1b[31m\u202A";
  assert.equal(sanitizeForDisplay(malicious), "evil-server");
});

test("sanitizes description with C0 controls and CSI", () => {
  const malicious = "A helpful tool\x08\x08\x08\x08\x1b[4m that does bad things";
  assert.equal(sanitizeForDisplay(malicious), "A helpful tool that does bad things");
});

test("empty string passes through", () => {
  assert.equal(sanitizeForDisplay(""), "");
});
