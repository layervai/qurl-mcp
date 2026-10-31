import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const action = readFileSync(".github/actions/publish-mcp-registry/action.yml", "utf8");
const install = action.match(/ {6}run: \|\n([\s\S]*?)(?=\n {4}- name:)/)?.[1];
if (!install) throw new Error("Publisher install step not found");
const script = install.replace(/^ {8}/gm, "");
const version = action.match(/publisher-version:[\s\S]*?default: (\S+)/)?.[1] ?? "";
const checksum = action.match(/publisher-sha256:[\s\S]*?default: (\S+)/)?.[1] ?? "";

function runInstall(tag: string, sha: string) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-publisher-test-"));
  try {
    const capture = join(dir, "request");
    writeFileSync(
      join(dir, "curl"),
      '#!/bin/bash\nprintf "%s\\n" "$@" > "$PUBLISHER_CAPTURE"\nexit 73\n',
    );
    chmodSync(join(dir, "curl"), 0o700);
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        PUBLISHER_CAPTURE: capture,
        PUBLISHER_VERSION: tag,
        PUBLISHER_SHA256: sha,
      },
    });
    return {
      status: result.status,
      request: existsSync(capture) ? readFileSync(capture, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("publisher install trust boundary", () => {
  it.each(["", "v1.7.5", "v1.8.0-rc1", "v1.7.9/../../other", "$(touch unwanted)", "v1.7.9\nextra"])(
    "rejects invalid or obsolete version %j before download",
    (tag) => {
      expect(runInstall(tag, checksum)).toEqual({ status: 1, request: "" });
    },
  );
  it.each(["", "bad", "a".repeat(63), "a".repeat(65), `${"a".repeat(64)}\nextra`])(
    "rejects invalid checksum %j before download",
    (sha) => {
      expect(runInstall(version, sha)).toEqual({ status: 1, request: "" });
    },
  );
  it.each([version, "v1.7.6", "v1.8.0", "v1.10.0"])(
    "uses the fixed upstream host for %s",
    (tag) => {
      const result = runInstall(tag, checksum);
      expect(result.status).toBe(73); // The fake download stops before checksum, extraction, or auth.
      expect(result.request).toContain(
        `https://github.com/modelcontextprotocol/registry/releases/download/${tag}/mcp-publisher_linux_amd64.tar.gz`,
      );
    },
  );
});
