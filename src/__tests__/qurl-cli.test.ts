import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cliCallContext,
  QURL_CLI_INSTALL_COMMAND,
  QURL_CLI_MISSING_MESSAGE,
  QurlCli,
  QurlCliError,
  sanitizeCliText,
} from "../qurl-cli.js";
import { makeFakeQurl, type FakeQurl } from "./fake-qurl.js";

describe("QurlCli", () => {
  let fake: FakeQurl;
  const empties: string[] = [];

  function emptyDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "no-qurl-"));
    empties.push(dir);
    return dir;
  }

  beforeEach(() => {
    fake = makeFakeQurl();
  });

  afterEach(() => {
    fake.cleanup();
    for (const dir of empties.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("runs the binary with an argument array plus --output=json and parses the document", async () => {
    const cli = fake.cli({ stdout: { crid: "x", ok: true } });

    await expect(cli.runJson(["list", "--status=active"])).resolves.toEqual({
      crid: "x",
      ok: true,
    });
    expect(fake.calls()).toEqual([
      { argv: ["list", "--status=active", "--output=json"], hasApiKey: false },
    ]);
  });

  it("passes shell metacharacters through as literal arguments", async () => {
    const cli = fake.cli({ stdout: {} });
    const hostile = "$(touch pwned); `id` | cat > x";

    await cli.runJson(["publish", hostile]);

    expect(fake.calls()[0]?.argv).toEqual(["publish", hostile, "--output=json"]);
  });

  it("removes QURL_API_KEY from the child environment", async () => {
    const cli = fake.cli({ stdout: {} }, { env: { QURL_API_KEY: "" } });

    await cli.runJson(["list"]);

    expect(fake.calls()[0]?.hasApiKey).toBe(false);
  });

  it("returns the install instruction when qurl is not on PATH or in the fallback dirs", async () => {
    const cli = new QurlCli({ env: { PATH: emptyDir() }, fallbackDirs: [emptyDir()] });

    expect(cli.findBinary()).toBeUndefined();
    const error = await cli.runJson(["list"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QurlCliError);
    expect((error as QurlCliError).code).toBe("cli_missing");
    expect((error as QurlCliError).message).toBe(QURL_CLI_MISSING_MESSAGE);
    expect(QURL_CLI_MISSING_MESSAGE).toContain(QURL_CLI_INSTALL_COMMAND);
    expect(QURL_CLI_INSTALL_COMMAND).toContain("scripts/install.sh");
  });

  it("finds qurl in a fallback directory when PATH lacks it", () => {
    const cli = new QurlCli({ env: { PATH: "" }, fallbackDirs: [emptyDir(), fake.dir] });

    expect(cli.findBinary()).toBe(join(fake.dir, "qurl"));
  });

  it("looks in the installer's ~/.local/bin first by default, and finds a CLI installed later", () => {
    const home = emptyDir();
    const bin = join(home, ".local", "bin");
    const cli = new QurlCli({ env: { PATH: "" }, homeDir: home, platform: "linux" });
    expect(cli.findBinary()).not.toBe(join(bin, "qurl"));

    mkdirSync(bin, { recursive: true });
    copyFileSync(join(fake.dir, "qurl"), join(bin, "qurl"));
    chmodSync(join(bin, "qurl"), 0o755);

    expect(cli.findBinary()).toBe(join(bin, "qurl"));
  });

  it("has no default fallback directories on Windows", () => {
    const cli = new QurlCli({ env: { PATH: "" }, homeDir: emptyDir(), platform: "win32" });

    expect(cli.findBinary()).toBeUndefined();
  });

  it("skips relative PATH entries and files that are not executable", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "qurl"), "not executable");
    chmodSync(join(dir, "qurl"), 0o644);
    const cli = new QurlCli({ env: { PATH: `.:${dir}:relative/bin` }, fallbackDirs: [] });

    expect(cli.findBinary()).toBeUndefined();
  });

  it("surfaces a non-zero exit as a clean error with the exit meaning and sanitized stderr", async () => {
    const cli = fake.cli({
      exit: 5,
      stderr: "\u001b[31mError:\u001b[0m resource not found\n  hint: check the CRID\u0007\n",
    });

    const error = (await cli.runJson(["share", "abc"]).catch((e: unknown) => e)) as QurlCliError;

    expect(error).toBeInstanceOf(QurlCliError);
    expect(error.code).toBe("cli_failed");
    expect(error.exitCode).toBe(5);
    expect(error.message).toBe(
      "qurl share failed (exit 5: not found: a wrong CRID, a deleted resource, or a resource this machine does not own). qurl said: Error: resource not found hint: check the CRID",
    );
  });

  it("tells the user to upgrade when an old CLI does not know a command", async () => {
    const cli = fake.cli({ exit: 2, stderr: 'Error: unknown command "access" for "qurl"' });

    const error = (await cli.runJson(["access", "list_grants"]).catch((e: unknown) => e)) as Error;

    expect(error.message).toContain("exit 2: usage error");
    expect(error.message).toContain("may be too old");
  });

  it("describes an unknown exit code without inventing a meaning", async () => {
    const cli = fake.cli({ exit: 42 });

    const error = (await cli.runJson(["list"]).catch((e: unknown) => e)) as Error;

    expect(error.message).toBe("qurl list failed (exit 42: unknown failure).");
  });

  it("stops a run that exceeds its timeout", async () => {
    const cli = fake.cli({ stdout: {}, sleepMs: 10_000 }, { timeoutMs: 200, killGraceMs: 100 });
    const started = Date.now();

    const error = (await cli.runJson(["publish", "x"]).catch((e: unknown) => e)) as QurlCliError;

    expect(error.code).toBe("cli_timeout");
    expect(error.message).toContain("did not finish within 1 second");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a run when its tool call is cancelled", async () => {
    const cli = fake.cli({ stdout: {}, sleepMs: 10_000 }, { killGraceMs: 100 });
    const controller = new globalThis.AbortController();
    const started = Date.now();

    const pending = cli
      .runJson(["publish", "x"], { signal: controller.signal })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(fake.calls()).toHaveLength(1));
    controller.abort();
    const error = (await pending) as QurlCliError;

    expect(error.code).toBe("cli_cancelled");
    expect(error.message).toContain("check with list_crids before retrying");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps a finished run when its call is cancelled after the process exited", async () => {
    const cli = fake.cli({ stdout: { ok: true } });
    const controller = new globalThis.AbortController();

    const document = await cliCallContext.run({ signal: controller.signal }, async () => {
      const run = cli.runJson(["list"]);
      await vi.waitFor(() => expect(fake.calls()).toHaveLength(1));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
      controller.abort();
      return run;
    });

    expect(document).toEqual({ ok: true });
  });

  it("never starts a run whose call was cancelled before it began", async () => {
    const cli = fake.cli({ stdout: {} });
    const controller = new globalThis.AbortController();
    controller.abort();

    const error = (await cli
      .runJson(["publish", "x"], { signal: controller.signal })
      .catch((e: unknown) => e)) as QurlCliError;

    expect(error.code).toBe("cli_cancelled");
    expect(fake.calls()).toHaveLength(0);
  });

  it("reads the cancel signal of the tool call it runs in", async () => {
    const cli = fake.cli({ stdout: {}, sleepMs: 10_000 }, { killGraceMs: 100 });
    const controller = new globalThis.AbortController();

    const pending = cliCallContext
      .run({ signal: controller.signal }, () => cli.runJson(["list"]))
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(fake.calls()).toHaveLength(1));
    controller.abort();

    expect(((await pending) as QurlCliError).code).toBe("cli_cancelled");
  });

  it("runs at most three CLI processes at once, and starts the next when one ends", async () => {
    // Each run takes 3 s, so the fourth cannot start inside the check below
    // even on a loaded machine where the first three start far apart.
    const cli = fake.cli({ stdout: {}, sleepMs: 3_000 });

    const runs = [1, 2, 3, 4].map((n) => cli.runJson(["list", `--limit=${n}`]));
    await vi.waitFor(() => expect(fake.calls()).toHaveLength(3));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
    expect(fake.calls()).toHaveLength(3);
    await Promise.all(runs);

    expect(fake.calls()).toHaveLength(4);
  }, 15_000);

  it("drops a waiting run whose call is cancelled, so it never starts", async () => {
    const cli = fake.cli({ stdout: {}, sleepMs: 800 });
    const controller = new globalThis.AbortController();

    const running = [1, 2, 3].map((n) => cli.runJson(["list", `--limit=${n}`]));
    const waiting = cli
      .runJson(["list", "--limit=9"], { signal: controller.signal })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(fake.calls()).toHaveLength(3));
    controller.abort();

    expect(((await waiting) as QurlCliError).code).toBe("cli_cancelled");
    await Promise.all(running);
    expect(fake.calls().map((call) => call.argv[1])).not.toContain("--limit=9");
  });

  it("honours a per-call timeout", async () => {
    const cli = fake.cli({ stdout: {}, sleepMs: 10_000 }, { killGraceMs: 100 });

    const error = (await cli
      .runJson(["publish", "x"], { timeoutMs: 1_500 })
      .catch((e: unknown) => e)) as QurlCliError;

    expect(error.code).toBe("cli_timeout");
    expect(error.message).toContain("within 2 seconds");
  });

  it("stops a run whose output exceeds the bound", async () => {
    const cli = fake.cli(
      { stdout: "x".repeat(4096), sleepMs: 10_000 },
      { maxStdoutBytes: 100, killGraceMs: 100 },
    );

    const error = (await cli.runJson(["list"]).catch((e: unknown) => e)) as QurlCliError;

    expect(error.code).toBe("cli_output_too_large");
  });

  it("bounds stderr in the error message", async () => {
    const cli = fake.cli({ exit: 1, stderr: "e".repeat(10_000) }, { maxStderrBytes: 50 });

    const error = (await cli.runJson(["list"]).catch((e: unknown) => e)) as Error;

    expect(error.message).toContain(`qurl said: ${"e".repeat(50)}`);
    expect(error.message).not.toContain("e".repeat(51));
  });

  it.each([
    ["not JSON", "CRID: abc"],
    ["an array", "[1,2]"],
    ["null", "null"],
    ["empty", ""],
  ])("rejects output that is %s", async (_label, stdout) => {
    const cli = fake.cli({ stdout });

    const error = (await cli.runJson(["list"]).catch((e: unknown) => e)) as QurlCliError;

    expect(error.code).toBe("cli_bad_output");
    expect(error.message).toContain("did not return a JSON document");
  });

  it("reports a binary that cannot be started as missing", async () => {
    const dir = emptyDir();
    // Executable bit set, but the interpreter does not exist.
    writeFileSync(join(dir, "qurl"), "#!/nonexistent/interpreter\n");
    chmodSync(join(dir, "qurl"), 0o755);
    const cli = new QurlCli({ env: { PATH: dir }, fallbackDirs: [] });

    const error = (await cli.runJson(["list"]).catch((e: unknown) => e)) as QurlCliError;

    expect(error.code).toBe("cli_missing");
  });
});

describe("sanitizeCliText", () => {
  it("removes escapes and control characters and joins lines", () => {
    expect(sanitizeCliText("\u001b]8;;http://x\u0007link\u001b]8;;\u0007\r\n\tnext line")).toBe(
      "link next line",
    );
  });

  it("caps the length", () => {
    expect(sanitizeCliText("a".repeat(5_000))).toHaveLength(1_500);
  });
});
