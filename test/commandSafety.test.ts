import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCommandBlockReason, isWarnProgram } from "../src/commandSafety.js";

// ─── Blocked programs ───────────────────────────────────────────────

describe("getCommandBlockReason — blocked programs", () => {
  it("blocks sudo", () => {
    assert.ok(getCommandBlockReason(["sudo", "rm", "-rf", "/"]));
  });

  it("blocks bash", () => {
    assert.ok(getCommandBlockReason(["bash", "-c", "echo hello"]));
  });

  it("blocks curl", () => {
    assert.ok(getCommandBlockReason(["curl", "https://evil.com"]));
  });

  it("blocks docker", () => {
    assert.ok(getCommandBlockReason(["docker", "run", "alpine"]));
  });

  it("blocks pip", () => {
    assert.ok(getCommandBlockReason(["pip", "install", "malware"]));
  });

  it("blocks osascript", () => {
    assert.ok(getCommandBlockReason(["osascript", "-e", "tell application"]));
  });

  it("allows ls", () => {
    assert.equal(getCommandBlockReason(["ls", "-la"]), null);
  });

  it("allows cat", () => {
    assert.equal(getCommandBlockReason(["cat", "README.md"]), null);
  });
});

// ─── Interpreter eval flags ─────────────────────────────────────────

describe("getCommandBlockReason — interpreter eval flags", () => {
  it("blocks python -c", () => {
    assert.ok(getCommandBlockReason(["python", "-c", "import os; os.system('rm -rf /')"]));
  });

  it("blocks node --eval", () => {
    assert.ok(getCommandBlockReason(["node", "--eval", "process.exit(1)"]));
  });

  it("allows python running a script file", () => {
    assert.equal(getCommandBlockReason(["python", "test_script.py"]), null);
  });

  it("allows node running a script file", () => {
    assert.equal(getCommandBlockReason(["node", "server.js"]), null);
  });
});

// ─── Shell operators in arguments ──────────────────────────────────

describe("getCommandBlockReason — shell operators", () => {
  it("blocks pipe in argument", () => {
    assert.ok(getCommandBlockReason(["grep", "foo | rm -rf /"]));
  });

  it("blocks semicolon in argument", () => {
    assert.ok(getCommandBlockReason(["echo", "hello; rm -rf /"]));
  });

  it("blocks dollar sign in argument", () => {
    assert.ok(getCommandBlockReason(["echo", "$HOME"]));
  });

  it("blocks output redirection", () => {
    assert.ok(getCommandBlockReason(["echo", ">file.txt"]));
  });

  it("allows clean arguments", () => {
    assert.equal(getCommandBlockReason(["grep", "-r", "TODO", "src/"]), null);
  });
});

// ─── Destructive git subcommands ────────────────────────────────────

describe("getCommandBlockReason — git subcommands", () => {
  it("blocks git push", () => {
    assert.ok(getCommandBlockReason(["git", "push", "origin", "main"]));
  });

  it("blocks git reset", () => {
    assert.ok(getCommandBlockReason(["git", "reset", "--hard"]));
  });

  it("blocks git clean", () => {
    assert.ok(getCommandBlockReason(["git", "clean", "-fd"]));
  });

  it("allows git status", () => {
    assert.equal(getCommandBlockReason(["git", "status"]), null);
  });

  it("allows git log", () => {
    assert.equal(getCommandBlockReason(["git", "log", "--oneline"]), null);
  });

  it("allows git diff", () => {
    assert.equal(getCommandBlockReason(["git", "diff"]), null);
  });
});

// ─── find with dangerous actions ────────────────────────────────────

describe("getCommandBlockReason — find actions", () => {
  it("blocks find -delete", () => {
    assert.ok(getCommandBlockReason(["find", ".", "-name", "*.tmp", "-delete"]));
  });

  it("blocks find -exec", () => {
    assert.ok(getCommandBlockReason(["find", ".", "-exec", "rm", "{}", ";"]));
  });

  it("allows find without dangerous actions", () => {
    assert.equal(getCommandBlockReason(["find", ".", "-name", "*.ts"]), null);
  });
});

// ─── Path-based program resolution ─────────────────────────────────

describe("getCommandBlockReason — path resolution", () => {
  it("blocks full-path programs", () => {
    assert.ok(getCommandBlockReason(["/usr/bin/sudo", "rm", "-rf", "/"]));
  });

  it("blocks .exe suffix on Windows", () => {
    assert.ok(getCommandBlockReason(["cmd.exe", "/c", "del"]));
  });
});

// ─── isWarnProgram ──────────────────────────────────────────────────

describe("isWarnProgram", () => {
  it("warns for npm", () => {
    assert.ok(isWarnProgram(["npm", "install"]));
  });

  it("warns for git", () => {
    assert.ok(isWarnProgram(["git", "status"]));
  });

  it("does not warn for ls", () => {
    assert.ok(!isWarnProgram(["ls", "-la"]));
  });

  it("does not warn for cat", () => {
    assert.ok(!isWarnProgram(["cat", "file.txt"]));
  });
});
