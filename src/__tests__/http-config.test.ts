import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigCache } from "../config.js";
import { loadHttpServerConfig } from "../http-config.js";

describe("HTTP listener config", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MCP_") || key.startsWith("QURL_MCP_")) delete process.env[key];
    }
    clearRuntimeConfigCache();
    tempDir = mkdtempSync(join(tmpdir(), "qurl-http-config-test-"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    clearRuntimeConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("defaults to a loopback-only bounded listener", () => {
    const config = loadHttpServerConfig(join(tempDir, "missing.json"));
    expect(config).toEqual(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 3000,
        trustProxyHops: 0,
        maxSessions: 1000,
        maxSessionsPerCredential: 20,
        maxUnvalidatedSessions: 100,
        sessionIdleTtlMs: 900_000,
        unvalidatedSessionTtlMs: 60_000,
        mcpRateLimitPerMinute: 120,
      }),
    );
  });

  it("requires Host validation for non-loopback listeners", () => {
    const configPath = join(tempDir, "http.json");
    writeFileSync(configPath, JSON.stringify({ host: "0.0.0.0" }));
    expect(() => loadHttpServerConfig(configPath)).toThrow("allowedHosts is required");

    writeFileSync(
      configPath,
      JSON.stringify({
        host: "0.0.0.0",
        baseUrl: "https://mcp.example.com",
        allowedHosts: ["MCP.Example.com"],
      }),
    );
    expect(loadHttpServerConfig(configPath).allowedHosts).toEqual(["mcp.example.com"]);
  });

  it("uses one loopback definition for listener and public base URLs", () => {
    const configPath = join(tempDir, "http.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        host: "127.0.0.2",
        baseUrl: "http://127.0.0.5:3000",
      }),
    );

    expect(loadHttpServerConfig(configPath)).toEqual(
      expect.objectContaining({
        host: "127.0.0.2",
        baseUrl: "http://127.0.0.5:3000",
        allowedHosts: undefined,
      }),
    );
  });

  it("accepts a bracketed IPv6 literal in the Host allowlist", () => {
    const configPath = join(tempDir, "http.json");
    writeFileSync(configPath, JSON.stringify({ allowedHosts: ["[::1]"] }));

    expect(loadHttpServerConfig(configPath).allowedHosts).toEqual(["[::1]"]);
  });

  it("rejects pathological Host allowlists", () => {
    const configPath = join(tempDir, "http.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        allowedHosts: Array.from({ length: 1_001 }, (_, index) => `host-${index}.example.com`),
      }),
    );

    expect(() => loadHttpServerConfig(configPath)).toThrow("at most 1000 entries");
  });

  it("parses bounded proxy, session, and rate-limit values", () => {
    const configPath = join(tempDir, "http.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        trustProxyHops: 1,
        maxSessions: 50,
        maxSessionsPerCredential: 7,
        maxUnvalidatedSessions: 20,
        sessionIdleTtlMs: 60_000,
        sessionAbsoluteTtlMs: 120_000,
        unvalidatedSessionTtlMs: 20_000,
        mcpRateLimitPerMinute: 30,
        publicFileRateLimitPerMinute: 40,
      }),
    );
    const config = loadHttpServerConfig(configPath);
    expect(config).toEqual(
      expect.objectContaining({
        trustProxyHops: 1,
        maxSessions: 50,
        maxSessionsPerCredential: 7,
        maxUnvalidatedSessions: 20,
        sessionIdleTtlMs: 60_000,
        sessionAbsoluteTtlMs: 120_000,
        unvalidatedSessionTtlMs: 20_000,
        mcpRateLimitPerMinute: 30,
        publicFileRateLimitPerMinute: 40,
      }),
    );

    process.env.MCP_TRUST_PROXY_HOPS = "11";
    expect(() => loadHttpServerConfig(configPath)).toThrow("between 0 and 10");

    delete process.env.MCP_TRUST_PROXY_HOPS;
    process.env.MCP_MAX_SESSIONS_PER_CREDENTIAL = "51";
    expect(() => loadHttpServerConfig(configPath)).toThrow("between 1 and 50");

    process.env.MCP_MAX_SESSIONS_PER_CREDENTIAL = "1e1";
    expect(() => loadHttpServerConfig(configPath)).toThrow("between 1 and 50");
  });

  it("requires the absolute session lifetime to cover the idle window", () => {
    const configPath = join(tempDir, "http.json");
    writeFileSync(
      configPath,
      JSON.stringify({ sessionIdleTtlMs: 120_000, sessionAbsoluteTtlMs: 60_000 }),
    );

    expect(() => loadHttpServerConfig(configPath)).toThrow(
      "must be greater than or equal to sessionIdleTtlMs",
    );
  });

  it("rejects unsafe public base URLs and Host entries with ports", () => {
    const configPath = join(tempDir, "http.json");
    writeFileSync(configPath, JSON.stringify({ baseUrl: "http://mcp.example.com" }));
    expect(() => loadHttpServerConfig(configPath)).toThrow("must use HTTPS");

    writeFileSync(configPath, JSON.stringify({ allowedHosts: ["mcp.example.com:443"] }));
    expect(() => loadHttpServerConfig(configPath)).toThrow("without ports or URL schemes");
  });
});
