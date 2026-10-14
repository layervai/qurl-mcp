import { Buffer } from "node:buffer";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

type CliEnv = Record<string, string | undefined>;
type CliPlatform = typeof process.platform;

/**
 * Runs the locally installed qURL CLI (`qurl`) for the no-account stdio mode.
 *
 * Safety rules, all enforced here rather than by callers:
 * - The binary is started directly with an argument array (`shell: false`),
 *   so no argument is ever interpreted by a shell.
 * - stdin is closed, so a command that would prompt cannot wait for input.
 * - Every run has a timeout (SIGTERM, then SIGKILL) and bounded stdout and
 *   stderr. Output beyond the bound stops the process.
 * - Only machine-readable output (`--output=json`) is parsed. Nothing the CLI
 *   prints is logged by this module.
 */

/** One-line install command for macOS and Linux, from the qURL agent skill. */
export const QURL_CLI_INSTALL_COMMAND =
  '(umask 022 && mkdir -p "$HOME/.local/bin" "$HOME/.local/state") && chmod go-w "$HOME/.local" "$HOME/.local/bin" "$HOME/.local/state" && curl -fsSL --proto \'=https\' https://raw.githubusercontent.com/layervai/qurl-integrations/main/scripts/install.sh | INSTALL_DIR="$HOME/.local/bin" sh';

export const QURL_CLI_MISSING_MESSAGE =
  "The qURL CLI (qurl) is not installed or could not be found. Show the user this install command and let them run it; do not run it without their approval. On macOS or Linux: " +
  QURL_CLI_INSTALL_COMMAND +
  " On Windows, download qurl.exe from https://github.com/layervai/qurl-integrations/releases/latest and put its folder on PATH. " +
  "No account is needed. This server also looks in ~/.local/bin, so no restart of the MCP client is needed after installing. " +
  "To use a LayerV account instead, set QURL_API_KEY in the MCP server environment.";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;
// After the process exits, its pipes normally close at once. A grandchild
// that inherited them (it should not: the CLI's background service is
// started by the OS service manager) must not hold a tool call open.
const PIPE_CLOSE_GRACE_MS = 2_000;
const MAX_ERROR_DETAIL_CHARS = 1_500;

export type QurlCliErrorCode =
  | "cli_missing"
  | "cli_failed"
  | "cli_timeout"
  | "cli_cancelled"
  | "cli_output_too_large"
  | "cli_bad_output";

/**
 * The tool call a CLI run belongs to. The server runs every tool handler in
 * this context with the MCP request's abort signal, so a call that the client
 * cancels (or gives up on at its own timeout) stops the qurl process instead
 * of leaving it running behind a failed call.
 */
export const cliCallContext = new AsyncLocalStorage<{ signal?: CancelSignal }>();

/** The part of an abort signal a run uses (the MCP request's signal fits it). */
export type CancelSignal = {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

/** At most this many qurl processes run at once; later calls wait their turn. */
const MAX_CONCURRENT_RUNS = 3;

export class QurlCliError extends Error {
  constructor(
    public readonly code: QurlCliErrorCode,
    message: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = "QurlCliError";
  }
}

export type QurlCliOptions = {
  /** Environment for the lookup and the child process (default: process.env). */
  env?: CliEnv;
  platform?: CliPlatform;
  homeDir?: string;
  /**
   * Directories searched after PATH. MCP clients often start servers with a
   * minimal PATH that lacks the installer's directories, so the default list
   * holds the places the official installer and Homebrew use.
   */
  fallbackDirs?: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
};

export type QurlCliRunOptions = { timeoutMs?: number; signal?: CancelSignal };

/** The surface the CLI-backed tools use; tests may substitute it. */
export interface IQurlCli {
  runJson(args: string[], options?: QurlCliRunOptions): Promise<unknown>;
}

// Exit codes are the CLI's stable scripting contract.
const EXIT_MEANINGS: Record<number, string> = {
  1: "general failure",
  2: "usage error: the command was not accepted; do not retry it unchanged",
  3: "configuration error: upgrade the qURL CLI or fix its configuration",
  4: "authentication failed: this machine's qURL identity was rejected; tell the user and do not edit qURL's state directory",
  5: "not found: a wrong CRID, a deleted resource, or a resource this machine does not own",
  6: "permission denied for this machine's identity",
  7: "conflict with the resource's current state",
  8: "invalid input",
  9: "rate limited: back off for minutes, not seconds",
  10: "server error: retry once later, then report it",
  11: "service unavailable: retry with backoff",
  12: "verification failed: the link did not match the CRID; treat it as tampering, do not retry around it, and tell the user",
  130: "interrupted",
};

// ANSI CSI/OSC escapes and every other control character except newline.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function sanitizeCliText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_ERROR_DETAIL_CHARS);
}

function isExecutableFile(file: string, platform: CliPlatform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class QurlCli implements IQurlCli {
  private readonly env: CliEnv;
  private readonly platform: CliPlatform;
  private readonly fallbackDirs: string[];
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly killGraceMs: number;

  constructor(options: QurlCliOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    const home = options.homeDir ?? this.env.HOME ?? homedir();
    this.fallbackDirs =
      options.fallbackDirs ??
      (this.platform === "win32"
        ? []
        : [
            join(home, ".local", "bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/home/linuxbrew/.linuxbrew/bin",
          ]);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  /**
   * Find `qurl` on PATH, then in the fallback directories. Relative PATH
   * entries are skipped: they would resolve against whatever directory the
   * MCP client started this server in. The lookup runs on every call, so a
   * CLI installed while the server runs is found without a restart.
   */
  findBinary(): string | undefined {
    const name = this.platform === "win32" ? "qurl.exe" : "qurl";
    const pathDirs = (this.env.PATH ?? this.env.Path ?? "")
      .split(this.platform === "win32" ? ";" : delimiter)
      .filter((dir) => dir && isAbsolute(dir));
    for (const dir of [...pathDirs, ...this.fallbackDirs]) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate, this.platform)) return candidate;
    }
    return undefined;
  }

  /**
   * Run `qurl <args> --output=json` and return the parsed JSON document.
   * Throws QurlCliError for every failure; its message is safe to show.
   */
  async runJson(args: string[], options: QurlCliRunOptions = {}): Promise<unknown> {
    const binary = this.findBinary();
    if (!binary) throw new QurlCliError("cli_missing", QURL_CLI_MISSING_MESSAGE);
    const command = args[0] ?? "";
    const signal = options.signal ?? cliCallContext.getStore()?.signal;
    await this.acquire(signal, command);
    let stdout: string;
    try {
      stdout = await this.run(binary, [...args, "--output=json"], command, { ...options, signal });
    } finally {
      this.release();
    }
    const text = stdout.trim();
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Reported below.
    }
    throw new QurlCliError(
      "cli_bad_output",
      `qurl ${command} did not return a JSON document. The command may have taken effect; check with list_crids before retrying, and upgrade the qURL CLI if this repeats.`,
    );
  }

  private running = 0;
  private readonly waiting: Array<() => void> = [];

  private acquire(signal: CancelSignal | undefined, command: string): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelled(command));
    if (this.running < MAX_CONCURRENT_RUNS) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", onAbort);
        this.running += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(cancelled(command));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(start);
    });
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }

  private childEnv(): CliEnv {
    // This mode runs only without an account key. An empty key in the
    // environment must not reach the CLI, where it reads as a bad credential.
    const env = { ...this.env };
    delete env.QURL_API_KEY;
    return env;
  }

  private run(
    binary: string,
    argv: string[],
    command: string,
    options: QurlCliRunOptions,
  ): Promise<string> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(binary, argv, {
          env: this.childEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
      } catch {
        reject(new QurlCliError("cli_missing", QURL_CLI_MISSING_MESSAGE));
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: QurlCliError | undefined;
      let settled = false;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;

      const exited = () => child.exitCode !== null || child.signalCode !== null;
      const stop = (reason: QurlCliError) => {
        failure ??= reason;
        if (exited()) return;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), this.killGraceMs);
        killTimer.unref?.();
      };

      // A timeout or a cancel that comes after the process exited (while its
      // pipes drain) does not undo a run that finished: only a run that is
      // still going is stopped and reported as such.
      const timer = setTimeout(
        () =>
          !exited() &&
          stop(
            new QurlCliError(
              "cli_timeout",
              `qurl ${command} did not finish within ${formatSeconds(timeoutMs)} and was stopped. It may have taken effect; check with list_crids before retrying.`,
            ),
          ),
        timeoutMs,
      );

      const signal = options.signal;
      const onAbort = () => {
        if (!exited()) stop(cancelled(command));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      const finish = () => {
        if (settled) return;
        signal?.removeEventListener("abort", onAbort);
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (closeTimer) clearTimeout(closeTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (failure) {
          reject(failure);
          return;
        }
        if (exitCode === 0) {
          resolve(Buffer.concat(stdoutChunks).toString("utf8"));
          return;
        }
        const code = exitCode ?? -1;
        const meaning =
          EXIT_MEANINGS[code] ?? (exitSignal ? `stopped by ${exitSignal}` : "unknown failure");
        const detail = sanitizeCliText(Buffer.concat(stderrChunks).toString("utf8"));
        const upgrade = /unknown (command|flag|shorthand flag)/i.test(detail)
          ? " This qURL CLI may be too old for this tool; upgrade it by running the install command again: " +
            QURL_CLI_INSTALL_COMMAND
          : "";
        reject(
          new QurlCliError(
            "cli_failed",
            `qurl ${command} failed (exit ${code}: ${meaning}).${detail ? ` qurl said: ${detail}` : ""}${upgrade}`,
            code,
          ),
        );
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxStdoutBytes) {
          stop(
            new QurlCliError(
              "cli_output_too_large",
              `qurl ${command} returned more output than this server accepts (${this.maxStdoutBytes} bytes) and was stopped.`,
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes >= this.maxStderrBytes) return;
        const room = this.maxStderrBytes - stderrBytes;
        stderrChunks.push(chunk.subarray(0, room));
        stderrBytes += Math.min(room, chunk.length);
      });
      child.on("error", (error: Error & { code?: string }) => {
        if (error.code === "ENOENT" || error.code === "EACCES") {
          failure ??= new QurlCliError("cli_missing", QURL_CLI_MISSING_MESSAGE);
        } else {
          failure ??= new QurlCliError(
            "cli_failed",
            `qurl ${command} could not be started (${error.code ?? "error"}).`,
          );
        }
        finish();
      });
      child.on("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        closeTimer = setTimeout(finish, PIPE_CLOSE_GRACE_MS);
        closeTimer.unref?.();
      });
      child.on("close", (code, signal) => {
        exitCode ??= code;
        exitSignal ??= signal;
        finish();
      });
    });
  }
}

function cancelled(command: string): QurlCliError {
  return new QurlCliError(
    "cli_cancelled",
    `qurl ${command} was stopped because the tool call was cancelled. It may have taken effect; check with list_crids before retrying.`,
  );
}
