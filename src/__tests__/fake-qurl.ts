import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QurlCli, type QurlCliOptions } from "../qurl-cli.js";

/**
 * A fake `qurl` executable on a temporary PATH. Each run appends its argv
 * (and whether QURL_API_KEY reached it) to a log, then prints the configured
 * stdout and stderr and exits with the configured code. It runs with this
 * test process's own Node binary, so it needs nothing else on PATH.
 */
export type FakeReply = {
  stdout?: string | object;
  stderr?: string;
  exit?: number;
  sleepMs?: number;
};

export type FakeQurl = {
  dir: string;
  cli: (reply?: FakeReply, options?: QurlCliOptions) => QurlCli;
  calls: () => Array<{ argv: string[]; hasApiKey: boolean }>;
  cleanup: () => void;
};

const SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(
  process.env.FAKE_QURL_LOG,
  JSON.stringify({ argv: process.argv.slice(2), hasApiKey: "QURL_API_KEY" in process.env }) + "\\n",
);
process.stdout.write(process.env.FAKE_QURL_STDOUT || "");
process.stderr.write(process.env.FAKE_QURL_STDERR || "");
const code = Number(process.env.FAKE_QURL_EXIT || "0");
const sleep = Number(process.env.FAKE_QURL_SLEEP_MS || "0");
if (sleep > 0) setTimeout(() => process.exit(code), sleep);
else process.exitCode = code;
`;

export function makeFakeQurl(): FakeQurl {
  const dir = mkdtempSync(join(tmpdir(), "fake-qurl-"));
  const binary = join(dir, "qurl");
  writeFileSync(binary, SCRIPT);
  chmodSync(binary, 0o755);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  return {
    dir,
    cli: (reply = {}, options = {}) =>
      new QurlCli({
        fallbackDirs: [],
        ...options,
        env: {
          PATH: dir,
          HOME: dir,
          FAKE_QURL_LOG: log,
          FAKE_QURL_STDOUT:
            typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout ?? {}),
          FAKE_QURL_STDERR: reply.stderr ?? "",
          FAKE_QURL_EXIT: String(reply.exit ?? 0),
          FAKE_QURL_SLEEP_MS: String(reply.sleepMs ?? 0),
          ...options.env,
        },
      }),
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { argv: string[]; hasApiKey: boolean }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const SAMPLE_CRID = "aea6x7mea52zcalolw7nis3g4iy3rcfr7nzyfukkuujsqufnxhmvhhtledfa";
