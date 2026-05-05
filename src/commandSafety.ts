/**
 * Command-safety validation — extracted from index.ts for testability.
 *
 * Defense-in-depth: runs alongside the Rust executor's denylist.
 * Both must pass before a command reaches the human approval gate.
 *
 * Pure functions: no I/O, no global state.
 */

import { sanitizeForDisplay } from "./sanitize.js";

// ─── Blocked / Warned program sets ─────────────────────────────────

export const BLOCKED_PROGRAMS: ReadonlySet<string> = new Set([
  // Privilege escalation
  "sudo", "su", "doas", "pkexec", "runas",
  // Interactive shells (arbitrary code execution)
  "bash", "sh", "zsh", "fish", "csh", "tcsh", "ksh", "dash",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  // Execution wrappers / launchers (bypass denylist by wrapping real program)
  "nohup", "env", "xargs", "nice", "ionice", "timeout", "stdbuf", "setsid",
  "open", "xdg-open", "start",
  // Background / scheduling / multiplexing
  "screen", "tmux", "at", "batch", "crontab", "nq",
  // Remote access / exfiltration
  "ssh", "scp", "sftp", "rsync", "telnet", "ftp", "nc", "ncat", "netcat", "socat",
  // Network data transfer
  "curl", "wget", "httpie",
  // macOS automation (can control any app, click UI, read screen)
  "osascript", "automator",
  // Disk / filesystem destruction
  "dd", "mkfs", "fdisk", "parted", "diskutil", "format",
  // System management
  "systemctl", "service", "launchctl", "shutdown", "reboot", "halt", "init",
  // Container / VM escape vectors
  "docker", "podman", "kubectl", "vagrant", "virsh",
  // Package managers (can install arbitrary code)
  "apt", "apt-get", "yum", "dnf", "pacman", "brew", "pip", "pip3",
  "gem", "cargo", "go",
  // Credential access
  "security", "keychain", "pass", "gpg",
  // Compilers as code execution vectors (can run arbitrary code via -run, etc.)
  "gcc", "g++", "clang", "clang++", "cc", "c++",
]);

export const PERMISSION_MUTATION_PROGRAMS: ReadonlySet<string> = new Set(["chmod", "chown", "chgrp"]);

export const WARN_PROGRAMS: ReadonlySet<string> = new Set([
  // These are sometimes legitimate but deserve extra scrutiny
  "npm", "npx", "yarn", "pnpm", "bun",
  "git", "gh",
  "make", "cmake",
]);

/**
 * Argument patterns that are dangerous regardless of the program.
 * Catches shell injection attempts and inline code execution.
 */
export const BLOCKED_ARG_PATTERNS: readonly RegExp[] = [
  // Shell operators that should never appear in argv-form commands
  /[|;&`$]/, // pipe, semicolon, ampersand, backtick, dollar sign
  />\s*/,    // output redirection
  /<<?\s*/,  // input redirection / heredoc
];

// ─── Main validation ───────────────────────────────────────────────

function programName(raw: string | undefined): string {
  const basename = (raw || "").split(/[\\/]/).pop()?.toLowerCase() || "";
  return basename.replace(/\.(exe|cmd|bat|com)$/, "");
}

function rmHasForceAndRecursive(args: readonly string[]): boolean {
  let hasForce = false;
  let hasRecursive = false;

  for (const arg of args) {
    if (!arg.startsWith("-")) {
      continue;
    }

    if (arg === "--force") {
      hasForce = true;
      continue;
    }
    if (arg === "--recursive" || arg === "--dir") {
      hasRecursive = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      hasForce ||= arg.includes("f");
      hasRecursive ||= arg.includes("r") || arg.includes("R");
    }
  }

  return hasForce && hasRecursive;
}

export function getCommandBlockReason(command: string[]): string | null {
  const program = programName(command[0]);

  if (BLOCKED_PROGRAMS.has(program)) {
    return `Program "${program}" is blocked. It can be used for privilege escalation, remote access, or arbitrary code execution.`;
  }

  if (PERMISSION_MUTATION_PROGRAMS.has(program)) {
    return `Program "${program}" is blocked because it changes file permissions or ownership.`;
  }

  // Block interpreters with inline eval flags
  const interpreters = new Set(["python", "python3", "node", "deno", "ruby", "perl", "php", "lua"]);
  if (interpreters.has(program)) {
    const evalFlags = new Set(["-c", "-e", "-p", "--eval", "--print", "-exec"]);
    if (command.slice(1).some((arg) => evalFlags.has(arg))) {
      return `Inline code execution via "${program}" is blocked. Run a script file instead.`;
    }
  }

  // Block shell operators in arguments (shell injection via argv)
  for (let i = 1; i < command.length; i++) {
    for (const pattern of BLOCKED_ARG_PATTERNS) {
      if (pattern.test(command[i])) {
        return `Argument "${sanitizeForDisplay(command[i])}" contains shell operators. Use argv-form only, no pipes, redirects, or chaining.`;
      }
    }
  }

  // Block destructive git subcommands
  if (program === "git") {
    const subcommand = command[1]?.toLowerCase();
    const destructiveGitOps = new Set([
      "push", "clean", "reset", "rebase", "merge", "cherry-pick",
      "rm", "mv", "remote", "config", "filter-branch",
    ]);
    if (subcommand && destructiveGitOps.has(subcommand)) {
      return `"git ${subcommand}" is blocked during execution rounds. Only read-only git operations (status, log, diff, show, branch, etc.) are allowed.`;
    }
  }

  // Match the Rust executor's destructive rm policy before prompting the user.
  if (program === "rm" && rmHasForceAndRecursive(command.slice(1))) {
    return `"rm" with both recursive and force flags is blocked.`;
  }

  // Block destructive find arguments
  if (program === "find") {
    const dangerousActions = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);
    if (command.slice(1).some((arg) => dangerousActions.has(arg))) {
      return `"find" with mutation actions (-delete, -exec) is blocked.`;
    }
  }

  return null;
}

export function isWarnProgram(command: string[]): boolean {
  const program = programName(command[0]);
  return WARN_PROGRAMS.has(program);
}
