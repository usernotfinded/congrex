/**
 * @module sanitize
 *
 * Shared display-layer sanitizer for untrusted strings (MCP tool names,
 * descriptions, server names, error messages, etc.).
 *
 * Strips terminal escape sequences, control characters, and BiDi overrides
 * so that external input cannot hijack the terminal UI.
 *
 * IMPORTANT: This is for DISPLAY only. Internal logic (fingerprinting,
 * tool index lookups, etc.) should use raw values.
 */

/**
 * Strips dangerous characters from a string before it is printed to the
 * terminal or used in interactive Clack UI.
 *
 * Removed categories:
 *   - ANSI escape sequences: CSI (ESC[...), OSC (ESC]...BEL), single-char escapes
 *   - Unicode BiDi control characters (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069)
 *   - C0 control characters (0x00-0x1F except \t and \n) and DEL (0x7F)
 *   - C1 control character range (U+0080-U+009F) — includes 8-bit CSI, OSC, DCS, ST
 */
export function sanitizeForDisplay(str: string): string {
  return str
    // Strip ANSI escape sequences: CSI (ESC[...), OSC (ESC]...BEL), and single-char escapes
    .replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][AB012]|[>=<]|[78HMDE])/g, "")
    // Strip Unicode BiDi control characters (can visually reverse or override text direction)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    // Strip C0 control characters (except \t and \n) and DEL
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Strip C1 control character range (U+0080–U+009F) — includes 8-bit CSI, OSC, DCS, ST
    .replace(/[\u0080-\u009F]/g, "");
}
