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

  it("blocks chmod", () => {
    assert.ok(getCommandBlockReason(["chmod", "600", "secrets.txt"]));
  });

  it("blocks chown", () => {
    assert.ok(getCommandBlockReason(["chown", "root", "secrets.txt"]));
  });

  it("blocks chgrp", () => {
    assert.ok(getCommandBlockReason(["chgrp", "staff", "secrets.txt"]));
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

// ─── Destructive rm flags ───────────────────────────────────────────

describe("getCommandBlockReason — rm flags", () => {
  it("blocks rm -rf", () => {
    assert.ok(getCommandBlockReason(["rm", "-rf", "tmp"]));
  });

  it("blocks rm -fr", () => {
    assert.ok(getCommandBlockReason(["rm", "-fr", "tmp"]));
  });

  it("blocks rm with split recursive and force flags", () => {
    assert.ok(getCommandBlockReason(["rm", "-r", "-f", "tmp"]));
  });

  it("blocks rm with long recursive and force flags", () => {
    assert.ok(getCommandBlockReason(["rm", "--recursive", "--force", "tmp"]));
    assert.ok(getCommandBlockReason(["rm", "--force", "--recursive", "tmp"]));
  });

  it("blocks rm with uppercase recursive and force flags", () => {
    assert.ok(getCommandBlockReason(["rm", "-Rf", "tmp"]));
    assert.ok(getCommandBlockReason(["rm", "-R", "-f", "tmp"]));
  });

  it("allows non-recursive rm", () => {
    assert.equal(getCommandBlockReason(["rm", "tmp.txt"]), null);
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

  it("blocks path-qualified destructive rm", () => {
    assert.ok(getCommandBlockReason(["/bin/rm", "-rf", "target"]));
  });

  it("blocks executable-suffix destructive rm", () => {
    assert.ok(getCommandBlockReason(["rm.exe", "-rf", "target"]));
    assert.ok(getCommandBlockReason(["rm.cmd", "-rf", "target"]));
  });

  it("blocks path-qualified permission mutation commands", () => {
    assert.ok(getCommandBlockReason(["/usr/bin/chmod", "777", "file"]));
  });

  it("blocks executable-suffix permission mutation commands", () => {
    assert.ok(getCommandBlockReason(["chown.exe", "user", "file"]));
    assert.ok(getCommandBlockReason(["chgrp.bat", "group", "file"]));
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
