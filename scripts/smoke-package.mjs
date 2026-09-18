import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const directory = mkdtempSync(join(tmpdir(), "qurl-mcp-package-"));
try {
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(directory, pack.filename),
    ],
    { stdio: "inherit" },
  );
  execFileSync(process.execPath, ["--input-type=module", "-"], {
    cwd: directory,
    input: 'await import("@layervai/qurl-mcp"); await import("@layervai/qurl-mcp/dist/http.js");',
    timeout: 15_000,
  });
  for (const bin of ["qurl-mcp", "qurl-mcp-http"]) {
    const child = spawn(join(directory, "node_modules", ".bin", bin), [], {
      cwd: directory,
      env: { ...process.env, QURL_API_KEY: "", MCP_PORT: "invalid" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdin.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "package-smoke", version: "1" },
        },
      }) + "\n",
    );
    try {
      const [code] = await once(child, "close");
      if (bin === "qurl-mcp") {
        assert.equal(code, 0, errors);
        assert.match(output, /"serverInfo"/, "installed stdio bin must answer initialization");
      } else {
        assert.equal(code, 1, "installed HTTP bin must execute configuration validation");
        assert.match(errors, /startup failed/);
      }
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
