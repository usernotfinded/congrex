import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ExecutorErrorPayload = {
  code?: string;
  message?: string;
};

type ExecutorResponse<T> =
  | { id?: unknown; ok: true; result: T }
  | { id?: unknown; ok: false; error?: ExecutorErrorPayload };

export type CongrexExecutorEditInput = {
  filePath: string;
  search: string;
  replace: string;
};

export type CongrexExecutorEditResult = {
  real_path: string;
  bytes_written: number;
};

export type CongrexExecutorCommandInput = {
  command: string[];
  cwd?: string;
  timeoutMs?: number;
};

export type CongrexExecutorCommandResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
};

export type CongrexExecutorOptions = {
  binaryPath?: string;
  spawnCwd?: string;
  onStderrLine?: (line: string) => void;
};

export class CongrexExecutorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CongrexExecutorError";
  }
}

export class CongrexExecutor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: Interface | null = null;
  private stderrReader: Interface | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private shuttingDown = false;
  private recentStderr: string[] = [];

  constructor(private readonly options: CongrexExecutorOptions = {}) {}

  async editFile(input: CongrexExecutorEditInput): Promise<CongrexExecutorEditResult> {
    return await this.sendRequest<CongrexExecutorEditResult>(
      {
        action: "edit_file",
        file_path: input.filePath,
        search: input.search,
        replace: input.replace,
      },
      15_000,
    );
  }

  async executeCommand(input: CongrexExecutorCommandInput): Promise<CongrexExecutorCommandResult> {
    const timeoutMs = input.timeoutMs ?? 30_000;
    const requestTimeoutMs = Math.min(timeoutMs + 5_000, 70_000);
    return await this.sendRequest<CongrexExecutorCommandResult>(
      {
        action: "execute_command",
        command: input.command,
        cwd: input.cwd,
        timeout_ms: timeoutMs,
      },
      requestTimeoutMs,
    );
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.shuttingDown = true;
    this.clearReaders();
    this.child = null;
    if (!child) {
      this.shuttingDown = false;
      return;
    }

    child.stdin.end();
    child.kill();
    await once(child, "close").catch(() => undefined);
    this.shuttingDown = false;
  }

  private async sendRequest<T>(payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    const request = JSON.stringify({ id, ...payload }) + "\n";

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CongrexExecutorError("request_timeout", `Executor request timed out after ${timeoutMs}ms.`));
        this.restartChild();
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

      const wrote = child.stdin.write(request, "utf8", (error) => {
        if (!error) {
          return;
        }
        this.failPendingRequest(id, new CongrexExecutorError("write_failed", error.message));
        this.restartChild();
      });

      if (!wrote) {
        void once(child.stdin, "drain").catch(() => undefined);
      }
    });
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return this.child;
    }

    const binaryPath = this.resolveBinaryPath();
    const spawnCwd = this.options.spawnCwd ?? process.cwd();
    this.shuttingDown = false;
    this.recentStderr = [];

    const child = spawn(binaryPath, [], {
      cwd: spawnCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    this.child = child;
    this.stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity });

    this.stdoutReader.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    this.stderrReader.on("line", (line) => {
      this.pushRecentStderr(line);
      this.options.onStderrLine?.(line);
    });

    child.on("error", (error) => {
      this.handleProcessFailure(new CongrexExecutorError("spawn_failed", error.message));
    });

    child.on("close", (code, signal) => {
      const wasShuttingDown = this.shuttingDown;
      this.clearReaders();
      this.child = null;
      this.shuttingDown = false;

      if (wasShuttingDown && this.pending.size === 0) {
        return;
      }

      this.rejectAllPending(
        new CongrexExecutorError(
          "executor_closed",
          this.buildCloseMessage(code, signal),
        ),
      );
    });

    return child;
  }

  private resolveBinaryPath(): string {
    const envPath = process.env.CONGREX_EXECUTOR_BIN?.trim();
    const binaryPath =
      envPath && envPath.length > 0 ? envPath : fileURLToPath(new URL(`../congrex-executor/target/release/${binaryName()}`, import.meta.url));

    if (!existsSync(binaryPath)) {
      throw new CongrexExecutorError(
        "binary_not_found",
        `Rust executor binary not found at "${binaryPath}". Build it with "cargo build --release" inside congrex-executor, or set CONGREX_EXECUTOR_BIN.`,
      );
    }

    return binaryPath;
  }

  private handleStdoutLine(line: string): void {
    let parsed: ExecutorResponse<unknown>;
    try {
      parsed = JSON.parse(line) as ExecutorResponse<unknown>;
    } catch {
      this.handleProcessFailure(
        new CongrexExecutorError(
          "invalid_response",
          `Executor emitted invalid JSON: ${line.slice(0, 200)}`,
        ),
      );
      return;
    }

    if (typeof parsed.id !== "number") {
      this.handleProcessFailure(
        new CongrexExecutorError(
          "invalid_response",
          `Executor response is missing a numeric id: ${line.slice(0, 200)}`,
        ),
      );
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pending.resolve(parsed.result);
      return;
    }

    const error = parsed.error ?? {};
    pending.reject(
      new CongrexExecutorError(
        error.code || "executor_error",
        error.message || "Executor returned an unknown error.",
      ),
    );
  }

  private handleProcessFailure(error: Error): void {
    this.clearReaders();
    if (this.child) {
      this.shuttingDown = true;
      this.child.kill();
      this.child = null;
    }
    this.rejectAllPending(error);
    this.shuttingDown = false;
  }

  private restartChild(): void {
    this.clearReaders();
    if (!this.child) {
      return;
    }
    this.shuttingDown = true;
    this.child.kill();
    this.child = null;
  }

  private clearReaders(): void {
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = null;
    this.stderrReader = null;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private failPendingRequest(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pending.reject(error);
    this.pending.delete(id);
  }

  private buildCloseMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const parts = [
      `Congrex executor closed unexpectedly`,
      `(code=${code ?? "null"}, signal=${signal ?? "null"})`,
    ];
    if (this.recentStderr.length > 0) {
      parts.push(`stderr=${this.recentStderr.join(" | ")}`);
    }
    return parts.join(" ");
  }

  private pushRecentStderr(line: string): void {
    if (!line.trim()) {
      return;
    }
    this.recentStderr.push(line.trim());
    if (this.recentStderr.length > 12) {
      this.recentStderr.shift();
    }
  }
}

function binaryName(): string {
  return process.platform === "win32" ? "congrex-executor.exe" : "congrex-executor";
}
