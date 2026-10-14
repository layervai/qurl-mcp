import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
