import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { rateLimit } from "express-rate-limit";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync, type ReadStream } from "node:fs";
import { createServer as createNodeServer, request, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markRequestCredentialValidated } from "../auth/request-context.js";
import { QURLAPIError } from "../client.js";
import { createHttpRuntime } from "../http.js";
import type { HttpServerConfig } from "../http-config.js";
import { makeMockClient, sampleCreateQURLData } from "./helpers.js";

const testConfig: HttpServerConfig = {
  port: 3000,
  host: "127.0.0.1",
  baseUrl: "http://127.0.0.1:3000",
  trustProxyHops: 0,
  maxSessions: 100,
  maxSessionsPerCredential: 10,
  maxUnvalidatedSessions: 20,
  sessionIdleTtlMs: 15 * 60 * 1000,
  sessionAbsoluteTtlMs: 24 * 60 * 60 * 1000,
  unvalidatedSessionTtlMs: 60 * 1000,
  mcpRateLimitPerMinute: 10_000,
  publicFileRateLimitPerMinute: 10_000,
  maxUploadFileDataBytes: 10 * 1024 * 1024,
  defaultQurlApiUrl: "https://api.layerv.ai",
};
const runtime = createHttpRuntime(testConfig, { version: "0.0.0-test" });
const { app, closeAllSessions, getActiveSessionCount, streamPublicVideo, sweepExpiredSessions } =
  runtime;

const servers: Server[] = [];
const bearerHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
});
const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-test", version: "1.0" },
  },
};

async function start(serverApp = app): Promise<string> {
  const server = createNodeServer(serverApp);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  return `http://127.0.0.1:${address.port}`;
}

async function getStartedServerBaseUrl(server: Server): Promise<string> {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  return `http://127.0.0.1:${address.port}`;
}

async function initialize(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify(initializeBody),
  });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Expected MCP session id");
  return sessionId;
}

async function requestWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await closeAllSessions();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("HTTP MCP server", () => {
  it("creates isolated apps and session registries from explicit config", async () => {
    const otherRuntime = createHttpRuntime(
      { ...testConfig, baseUrl: "http://127.0.0.1:3001" },
      { version: "0.0.0-test" },
    );

    expect(otherRuntime.app).not.toBe(app);
    expect(otherRuntime.getActiveSessionCount()).toBe(0);
    expect(getActiveSessionCount()).toBe(0);

    const baseUrl = await start(otherRuntime.app);
    await initialize(baseUrl, "lv_live_isolated_runtime");
    expect(otherRuntime.getActiveSessionCount()).toBe(1);
    expect(getActiveSessionCount()).toBe(0);
    await otherRuntime.closeAllSessions();
  });

  it("serves a protected health endpoint surface without Express metadata", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it("authenticates before attempting to parse JSON", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("returns a bounded JSON-RPC error for malformed authenticated JSON", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_json_test"),
      body: "{not-json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: -32700,
          message: "Request body must be valid JSON.",
        }),
      }),
    );
  });

  it("returns a bounded JSON-RPC error for unsupported JSON character sets", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...bearerHeaders("lv_live_charset_test"),
        "content-type": "application/json; charset=iso-8859-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Request body could not be processed." }),
      }),
    );
  });

  it("handles non-string methods and array params as bounded unknown-session requests", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_adversarial_shape"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: 42, params: [] }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: -32000 }) }),
    );
  });

  it("returns 413 before session handling for an oversized valid JSON body", async () => {
    const limitedRuntime = createHttpRuntime(
      { ...testConfig, maxUploadFileDataBytes: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(limitedRuntime.app);
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_oversized_json"),
      body: JSON.stringify({ payload: "x".repeat(70_000) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: "Request body is too large." }),
      }),
    );
  });

  it("keeps a fresh session at the default body ceiling before credential validation", async () => {
    const raisedLimitRuntime = createHttpRuntime(
      { ...testConfig, maxUploadFileDataBytes: 20 * 1024 * 1024 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(raisedLimitRuntime.app);
    const token = "lv_live_large_first_request";

    try {
      const sessionId = await initialize(baseUrl, token);
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({ payload: "x".repeat(16 * 1024 * 1024) }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining("Complete a smaller qURL API call first"),
          }),
        }),
      );
    } finally {
      await raisedLimitRuntime.closeAllSessions();
    }
  });

  it("accepts the configured body ceiling after downstream credential validation", async () => {
    const raisedLimitRuntime = createHttpRuntime(
      { ...testConfig, maxUploadFileDataBytes: 20 * 1024 * 1024 },
      {
        version: "0.0.0-test",
        clientFactory: () =>
          makeMockClient({
            createQURL: vi.fn(async () => {
              markRequestCredentialValidated();
              return { data: sampleCreateQURLData() };
            }),
          }),
      },
    );
    const baseUrl = await start(raisedLimitRuntime.app);
    const token = "lv_live_large_validated_request";

    try {
      const sessionId = await initialize(baseUrl, token);
      const headers = { ...bearerHeaders(token), "mcp-session-id": sessionId };
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const validation = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "create_qurl", arguments: { target_url: "https://example.com" } },
        }),
      });
      expect(validation.status).toBe(200);

      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: { padding: "x".repeat(16 * 1024 * 1024) },
        }),
      });

      expect(response.status).not.toBe(413);
      expect(await response.text()).not.toContain("Request body is too large");
    } finally {
      await raisedLimitRuntime.closeAllSessions();
    }
  });

  it("initializes from a single-message JSON-RPC batch", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_batch_init"),
      body: JSON.stringify([initializeBody]),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    expect(getActiveSessionCount()).toBe(1);
  });

  it("rejects a mixed initialization batch without retaining a session", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: bearerHeaders("lv_live_mixed_batch_init"),
      body: JSON.stringify([
        initializeBody,
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      ]),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(getActiveSessionCount()).toBe(0);
  });

  it("rate-limits MCP requests before authentication", async () => {
    const limitedRuntime = createHttpRuntime(
      { ...testConfig, mcpRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(limitedRuntime.app);

    const first = await fetch(`${baseUrl}/mcp`, { method: "POST" });
    const second = await fetch(`${baseUrl}/mcp`, { method: "POST" });

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
  });

  it("resets MCP rate limits after the one-minute window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const limitedRuntime = createHttpRuntime(
      { ...testConfig, mcpRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(limitedRuntime.app);

    expect((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status).toBe(429);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status).toBe(401);
  });

  it("ignores spoofed forwarded addresses when proxy trust is disabled", async () => {
    const directRuntime = createHttpRuntime(
      { ...testConfig, trustProxyHops: 0, mcpRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(directRuntime.app);
    const postFrom = (forwardedFor: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "x-forwarded-for": forwardedFor },
      });

    expect((await postFrom("198.51.100.1")).status).toBe(401);
    expect((await postFrom("203.0.113.9")).status).toBe(429);
  });

  it("uses the configured trusted-proxy hop when keying client rate limits", async () => {
    const proxiedRuntime = createHttpRuntime(
      { ...testConfig, trustProxyHops: 1, mcpRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(proxiedRuntime.app);
    const postFrom = (forwardedFor: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "x-forwarded-for": forwardedFor },
      });

    const first = await postFrom("198.51.100.1, 203.0.113.10");
    const sameTrustedPosition = await postFrom("198.51.100.2, 203.0.113.10");
    const differentTrustedPosition = await postFrom("198.51.100.2, 203.0.113.11");

    expect(first.status).toBe(401);
    expect(sameTrustedPosition.status).toBe(429);
    expect(differentTrustedPosition.status).toBe(401);
  });

  it("also rate-limits one bearer credential across source IPs", async () => {
    const limitedRuntime = createHttpRuntime(
      { ...testConfig, trustProxyHops: 1, mcpRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(limitedRuntime.app);
    const postFrom = (token: string, forwardedFor: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "x-forwarded-for": forwardedFor },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    expect((await postFrom("lv_live_rotating", "198.51.100.1")).status).toBe(404);
    expect((await postFrom("lv_live_rotating", "203.0.113.9")).status).toBe(429);
    expect((await postFrom("lv_live_distinct", "192.0.2.44")).status).toBe(404);
  });

  it("rate-limits every runtime-wired public route", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));
    for (const route of ["/legal/privacy", "/media/video", "/media/video/file", "/healthz"]) {
      const publicRuntime = createHttpRuntime(
        {
          ...testConfig,
          publicFileRateLimitPerMinute: 1,
          publicVideo: {
            title: "Rate Limit Test",
            pagePath: "/media/video",
            filePath: fixturePath,
          },
        },
        { version: "0.0.0-test" },
      );
      const baseUrl = await start(publicRuntime.app);

      const first = await fetch(`${baseUrl}${route}`);
      await first.arrayBuffer();
      const second = await fetch(`${baseUrl}${route}`);

      expect(first.status, route).toBe(200);
      expect(second.status, route).toBe(429);
    }
  });

  it("isolates health probes from the legal and video rate-limit bucket", async () => {
    const publicRuntime = createHttpRuntime(
      { ...testConfig, publicFileRateLimitPerMinute: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(publicRuntime.app);

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/legal/privacy`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(429);
    expect((await fetch(`${baseUrl}/legal/privacy`)).status).toBe(429);
  });

  it("isolates video range requests from the public page rate-limit bucket", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));
    const publicRuntime = createHttpRuntime(
      {
        ...testConfig,
        publicFileRateLimitPerMinute: 1,
        publicVideo: {
          title: "Rate Limit Test",
          pagePath: "/media/video",
          filePath: fixturePath,
        },
      },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(publicRuntime.app);

    expect((await fetch(`${baseUrl}/media/video/file`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/legal/privacy`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/media/video/file`)).status).toBe(429);
    expect((await fetch(`${baseUrl}/legal/privacy`)).status).toBe(429);
  });

  it("wires the configured public video routes with matching CSP and media headers", async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));
    const publicRuntime = createHttpRuntime(
      {
        ...testConfig,
        publicVideo: {
          title: "Runtime Video Test",
          pagePath: "/custom/video",
          filePath: fixturePath,
        },
      },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(publicRuntime.app);

    const pageResponse = await fetch(`${baseUrl}/custom/video`);
    const html = await pageResponse.text();
    const inlineStyle = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    if (!inlineStyle) throw new Error("Expected inline video-page styles");
    const styleHash = createHash("sha256").update(inlineStyle, "utf8").digest("base64");

    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get("content-security-policy")).toContain(`'sha256-${styleHash}'`);
    expect(pageResponse.headers.get("content-security-policy")).not.toContain("'unsafe-inline'");
    expect(pageResponse.headers.get("content-security-policy")).toContain("media-src 'self'");
    expect(pageResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain('src="http://127.0.0.1:3000/custom/video/file"');

    const fileResponse = await fetch(`${baseUrl}/custom/video/file`, {
      headers: { range: "bytes=0-3" },
    });
    expect(fileResponse.status).toBe(206);
    expect(fileResponse.headers.get("content-type")).toBe("video/mp4");
    expect(fileResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(fileResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fileResponse.arrayBuffer()).byteLength).toBe(4);
  });

  it("binds sessions to the bearer token that initialized them", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_owner");

    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_other"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(rejected.status).toBe(404);

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_owner"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    expect(initialized.status).toBe(202);

    const listed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_owner"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('"name":"create_qurl"');
  });

  it("rejects missing and mismatched bearer tokens on session GET requests", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_sse_owner");
    const sessionHeaders = {
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
    };

    const missing = await fetch(`${baseUrl}/mcp`, { headers: sessionHeaders });
    const mismatched = await fetch(`${baseUrl}/mcp`, {
      headers: { ...sessionHeaders, authorization: "Bearer lv_live_sse_other" },
    });

    expect(missing.status).toBe(401);
    expect(mismatched.status).toBe(404);
  });

  it("uses each caller's bearer token for that session's outbound qURL call", async () => {
    const outboundKeys: string[] = [];
    const isolatedRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: (bearerToken) =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            outboundKeys.push(bearerToken);
            markRequestCredentialValidated();
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(isolatedRuntime.app);

    try {
      for (const token of ["lv_live_caller_a", "lv_live_caller_b"]) {
        const sessionId = await initialize(baseUrl, token);
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          }),
        });
        const created = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "create_qurl",
              arguments: { target_url: "https://example.com" },
            },
          }),
        });
        expect(created.status).toBe(200);
      }

      expect(outboundKeys).toEqual(["lv_live_caller_a", "lv_live_caller_b"]);
    } finally {
      await isolatedRuntime.closeAllSessions();
    }
  });

  it("logs batched tool calls without depending on a top-level params object", async () => {
    const batchedRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            markRequestCredentialValidated();
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(batchedRuntime.app);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const token = "lv_live_batched_logging";
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      write.mockClear();

      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "create_qurl",
              arguments: { target_url: "https://example.com" },
            },
          },
        ]),
      });

      expect(response.status).toBe(200);
      const output = write.mock.calls.flat().join("");
      expect(output).toContain("[mcp-http] tool call started");
      expect(output).toContain("[mcp-http] tool call finished");
    } finally {
      write.mockRestore();
      await batchedRuntime.closeAllSessions();
    }
  });

  it("rejects an unknown session id without creating state", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...bearerHeaders("lv_live_forged_session"),
        "mcp-session-id": "00000000-0000-4000-8000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(404);
    expect(getActiveSessionCount()).toBe(0);
  });

  it("uses the same operator log for unknown and wrong-credential sessions", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_log_owner");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const post = (token: string, requestedSessionId: string) =>
        fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { ...bearerHeaders(token), "mcp-session-id": requestedSessionId },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        });

      expect((await post("lv_live_log_other", sessionId)).status).toBe(404);
      expect((await post("lv_live_log_other", "missing-session")).status).toBe(404);
      expect(warn.mock.calls).toEqual([
        ["[mcp-http] session missing; client must re-initialize"],
        ["[mcp-http] session missing; client must re-initialize"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("evicts abandoned sessions after the configured idle window", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_idle");
    expect(getActiveSessionCount()).toBe(1);

    expect(await sweepExpiredSessions(Date.now() + 24 * 60 * 60 * 1000)).toBe(1);
    expect(getActiveSessionCount()).toBe(0);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders("lv_live_idle"), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);
  });

  it("expires unvalidated sessions exactly at the configured absolute deadline", async () => {
    const boundaryRuntime = createHttpRuntime(testConfig, { version: "0.0.0-test" });
    const baseUrl = await start(boundaryRuntime.app);
    const createdAt = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(createdAt);

    try {
      await initialize(baseUrl, "lv_live_ttl_boundary");
      now.mockRestore();

      expect(
        await boundaryRuntime.sweepExpiredSessions(
          createdAt + testConfig.unvalidatedSessionTtlMs - 1,
        ),
      ).toBe(0);
      expect(boundaryRuntime.getActiveSessionCount()).toBe(1);
      expect(
        await boundaryRuntime.sweepExpiredSessions(createdAt + testConfig.unvalidatedSessionTtlMs),
      ).toBe(1);
      expect(boundaryRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      now.mockRestore();
      await boundaryRuntime.closeAllSessions();
    }
  });

  it("expires an unvalidated session even while its SSE request is active", async () => {
    const baseUrl = await start();
    const token = "lv_live_pending_sse";
    const sessionId = await initialize(baseUrl, token);

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    expect(initialized.status).toBe(202);

    const controller = new globalThis.AbortController();
    const sse = await fetch(`${baseUrl}/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        "mcp-session-id": sessionId,
      },
      signal: controller.signal,
    });
    expect(sse.status).toBe(200);

    expect(await sweepExpiredSessions(Date.now() + 24 * 60 * 60 * 1000)).toBe(1);
    expect(getActiveSessionCount()).toBe(0);
    controller.abort();
  });

  it("expires a validated session at the absolute deadline during active SSE", async () => {
    const absoluteRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            markRequestCredentialValidated();
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(absoluteRuntime.app);
    const token = "lv_live_absolute_sse";
    const controller = new globalThis.AbortController();

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_qurl",
            arguments: { target_url: "https://example.com" },
          },
        }),
      });
      const sse = await fetch(`${baseUrl}/mcp`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
          "mcp-session-id": sessionId,
        },
        signal: controller.signal,
      });
      expect(sse.status).toBe(200);

      expect(
        await absoluteRuntime.sweepExpiredSessions(
          Date.now() + testConfig.sessionAbsoluteTtlMs + 1,
        ),
      ).toBe(1);
      expect(absoluteRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      controller.abort();
      await absoluteRuntime.closeAllSessions();
    }
  });

  it("does not register a transport that closes during initialization", async () => {
    const earlyCloseRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      transportFactory: () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => "early-close-session",
        });
        const handleRequest = transport.handleRequest.bind(transport);
        transport.handleRequest = async (...args) => {
          await handleRequest(...args);
          transport.onclose?.();
        };
        return transport;
      },
    });
    const baseUrl = await start(earlyCloseRuntime.app);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: bearerHeaders("lv_live_early_close"),
        body: JSON.stringify(initializeBody),
      });

      expect(response.status).toBe(200);
      expect(earlyCloseRuntime.getActiveSessionCount()).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        "[mcp-http] initialize transport closed before session registration",
      );
    } finally {
      warn.mockRestore();
      await earlyCloseRuntime.closeAllSessions();
    }
  });

  it("never exceeds the configured session cap during concurrent initialization", async () => {
    const cappedRuntime = createHttpRuntime(
      { ...testConfig, maxSessions: 1, maxUnvalidatedSessions: 2 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(cappedRuntime.app);

    try {
      const responses = await Promise.all(
        ["lv_live_race_a", "lv_live_race_b"].map((token) =>
          fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: bearerHeaders(token),
            body: JSON.stringify(initializeBody),
          }),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([200, 503]);
      expect(cappedRuntime.getActiveSessionCount()).toBe(1);
    } finally {
      await cappedRuntime.closeAllSessions();
    }
  });

  it("caps concurrent sessions per bearer credential without blocking other credentials", async () => {
    const cappedRuntime = createHttpRuntime(
      {
        ...testConfig,
        maxSessions: 3,
        maxSessionsPerCredential: 1,
        maxUnvalidatedSessions: 3,
      },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(cappedRuntime.app);

    try {
      const sameCredentialResponses = await Promise.all(
        [1, 2].map(() =>
          fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: bearerHeaders("lv_live_same_credential"),
            body: JSON.stringify(initializeBody),
          }),
        ),
      );
      const otherCredentialResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: bearerHeaders("lv_live_other_credential"),
        body: JSON.stringify(initializeBody),
      });

      expect(sameCredentialResponses.map((response) => response.status).sort()).toEqual([200, 503]);
      expect(otherCredentialResponse.status).toBe(200);
      expect(cappedRuntime.getActiveSessionCount()).toBe(2);
    } finally {
      await cappedRuntime.closeAllSessions();
    }
  });

  it("enforces the unvalidated-session cap independently", async () => {
    const cappedRuntime = createHttpRuntime(
      { ...testConfig, maxSessions: 2, maxUnvalidatedSessions: 1 },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(cappedRuntime.app);

    try {
      const first = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: bearerHeaders("lv_live_pending_a"),
        body: JSON.stringify(initializeBody),
      });
      const second = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: bearerHeaders("lv_live_pending_b"),
        body: JSON.stringify(initializeBody),
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(503);
      expect(cappedRuntime.getActiveSessionCount()).toBe(1);
    } finally {
      await cappedRuntime.closeAllSessions();
    }
  });

  it("promotes a session only after a successful downstream qURL call", async () => {
    const validatedRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            markRequestCredentialValidated();
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(validatedRuntime.app);
    const token = "lv_live_validated";
    const lastActivityAt = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(lastActivityAt);

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const created = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_qurl",
            arguments: { target_url: "https://example.com" },
          },
        }),
      });

      expect(created.status).toBe(200);
      now.mockRestore();
      expect(
        await validatedRuntime.sweepExpiredSessions(
          lastActivityAt + testConfig.sessionIdleTtlMs - 1,
        ),
      ).toBe(0);
      expect(validatedRuntime.getActiveSessionCount()).toBe(1);
      expect(
        await validatedRuntime.sweepExpiredSessions(lastActivityAt + testConfig.sessionIdleTtlMs),
      ).toBe(1);
      expect(validatedRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      now.mockRestore();
      await validatedRuntime.closeAllSessions();
    }
  });

  it("does not idle-evict a validated session while a tool request is active", async () => {
    let releaseCall!: () => void;
    const callReleased = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    let markCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    const activeRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            markRequestCredentialValidated();
            markCallStarted();
            await callReleased;
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(activeRuntime.app);
    const token = "lv_live_active_request";

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const toolResponse = fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_qurl",
            arguments: { target_url: "https://example.com" },
          },
        }),
      });
      await callStarted;

      expect(
        await activeRuntime.sweepExpiredSessions(Date.now() + testConfig.sessionIdleTtlMs + 1),
      ).toBe(0);
      releaseCall();
      expect((await toolResponse).status).toBe(200);
      expect(
        await activeRuntime.sweepExpiredSessions(Date.now() + testConfig.sessionIdleTtlMs + 1),
      ).toBe(1);
    } finally {
      releaseCall();
      await activeRuntime.closeAllSessions();
    }
  });

  it("returns 409 when a session closes during transport handling", async () => {
    let expiringRuntime!: ReturnType<typeof createHttpRuntime>;
    let requestCount = 0;
    expiringRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      transportFactory: () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => "mid-request-expiry-session",
        });
        const handleRequest = transport.handleRequest.bind(transport);
        transport.handleRequest = async (...args) => {
          requestCount += 1;
          if (requestCount === 3) {
            await expiringRuntime.closeAllSessions();
            throw new Error("transport failed after session expiry");
          }
          await handleRequest(...args);
        };
        return transport;
      },
    });
    const baseUrl = await start(expiringRuntime.app);
    const token = "lv_live_mid_request_expiry";

    try {
      const sessionId = await initialize(baseUrl, token);
      const headers = { ...bearerHeaders(token), "mcp-session-id": sessionId };
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            message: "Session closed during request. Please re-initialize.",
          }),
        }),
      );
    } finally {
      await expiringRuntime.closeAllSessions();
    }
  });

  it("runs the scheduled session sweep at the bounded interval", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const sweepRuntime = createHttpRuntime(
      {
        ...testConfig,
        port: 0,
        sessionIdleTtlMs: 1_000,
        unvalidatedSessionTtlMs: 1_000,
      },
      { version: "0.0.0-test" },
    );
    const server = sweepRuntime.startHttpServer();
    const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));

    try {
      const baseUrl = await getStartedServerBaseUrl(server);
      await initialize(baseUrl, "lv_live_scheduled_sweep");
      expect(sweepRuntime.getActiveSessionCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(sweepRuntime.getActiveSessionCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweepRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      sweepRuntime.shutdownHttpServer("test sweep shutdown");
      await closed;
    }
  });

  it("force-closes lingering connections and sessions after the shutdown grace period", async () => {
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    const initialSigintListeners = process.listenerCount("SIGINT");
    const shutdownRuntime = createHttpRuntime(
      { ...testConfig, port: 0 },
      { version: "0.0.0-test" },
    );
    const server = shutdownRuntime.startHttpServer();
    expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners + 1);
    expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners + 1);
    const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
    const controller = new globalThis.AbortController();

    try {
      const baseUrl = await getStartedServerBaseUrl(server);
      const token = "lv_live_shutdown_drain";
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const sse = await fetch(`${baseUrl}/mcp`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
          "mcp-session-id": sessionId,
        },
        signal: controller.signal,
      });
      expect(sse.status).toBe(200);

      const closeAllConnections = vi.spyOn(server, "closeAllConnections");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      shutdownRuntime.shutdownHttpServer("SIGTERM");
      expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(closeAllConnections).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(closeAllConnections).toHaveBeenCalledOnce();
      vi.useRealTimers();
      await closed;
      expect(shutdownRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      controller.abort();
      shutdownRuntime.shutdownHttpServer("test cleanup");
      if (server.listening) await closed;
      await shutdownRuntime.closeAllSessions();
    }
  });

  it("reaps a disconnected validated session after the reconnect grace period", async () => {
    const disconnectedRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            markRequestCredentialValidated();
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(disconnectedRuntime.app);
    const token = "lv_live_disconnect_grace";
    const controller = new globalThis.AbortController();

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_qurl",
            arguments: { target_url: "https://example.com" },
          },
        }),
      });
      const sse = await fetch(`${baseUrl}/mcp`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
          "mcp-session-id": sessionId,
        },
        signal: controller.signal,
      });
      expect(sse.status).toBe(200);
      await sse.body?.cancel();
      controller.abort();
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 25));

      expect(await disconnectedRuntime.sweepExpiredSessions(Date.now() + 29_000)).toBe(0);
      expect(await disconnectedRuntime.sweepExpiredSessions(Date.now() + 30_001)).toBe(1);
      expect(disconnectedRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      controller.abort();
      await disconnectedRuntime.closeAllSessions();
    }
  });

  it("keeps a session unvalidated after a downstream authentication failure", async () => {
    const rejectedRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi
            .fn()
            .mockRejectedValue(new QURLAPIError(401, "invalid_api_key", "Invalid API key.")),
        }),
    });
    const baseUrl = await start(rejectedRuntime.app);
    const token = "lv_live_rejected";

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const created = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "create_qurl", arguments: { target_url: "https://example.com" } },
        }),
      });

      expect(created.status).toBe(200);
      expect(await created.text()).toContain("Invalid API key");
      expect(
        await rejectedRuntime.sweepExpiredSessions(
          Date.now() + testConfig.unvalidatedSessionTtlMs + 1,
        ),
      ).toBe(1);
      expect(rejectedRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      await rejectedRuntime.closeAllSessions();
    }
  });

  it("removes sessions on explicit DELETE", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_delete");
    const close = vi.spyOn(McpServer.prototype, "close");

    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          authorization: "Bearer lv_live_delete",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
      });
      expect(response.status).toBe(200);
      expect(getActiveSessionCount()).toBe(0);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
    }
  });

  it("handles explicit DELETE while a tool request is in flight", async () => {
    let releaseCall!: () => void;
    const callReleased = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    let markCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    const deleteRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      clientFactory: () =>
        makeMockClient({
          createQURL: vi.fn(async () => {
            markRequestCredentialValidated();
            markCallStarted();
            await callReleased;
            return { data: sampleCreateQURLData() };
          }),
        }),
    });
    const baseUrl = await start(deleteRuntime.app);
    const token = "lv_live_concurrent_delete";

    try {
      const sessionId = await initialize(baseUrl, token);
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
      });
      const toolRequest = fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...bearerHeaders(token), "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_qurl",
            arguments: { target_url: "https://example.com" },
          },
        }),
      });
      await callStarted;
      const deleteRequest = fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
      });
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      releaseCall();

      const [toolOutcome, deleteOutcome] = await Promise.allSettled([toolRequest, deleteRequest]);
      expect(toolOutcome.status).toBe("fulfilled");
      expect(deleteOutcome.status).toBe("fulfilled");
      if (deleteOutcome.status === "fulfilled") expect(deleteOutcome.value.status).toBe(200);
      expect(deleteRuntime.getActiveSessionCount()).toBe(0);
    } finally {
      releaseCall();
      await deleteRuntime.closeAllSessions();
    }
  });

  it("does not let a mismatched bearer delete another credential's session", async () => {
    const baseUrl = await start();
    const sessionId = await initialize(baseUrl, "lv_live_delete_owner");

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer lv_live_delete_attacker",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
    });

    expect(response.status).toBe(404);
    expect(getActiveSessionCount()).toBe(1);
  });

  it("rejects Host headers outside the loopback allowlist", async () => {
    const baseUrl = await start();
    expect(await requestWithHost(`${baseUrl}/healthz`, "attacker.example")).toBe(403);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it("applies Origin validation only to MCP routes", async () => {
    const baseUrl = await start();

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/healthz`, {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { origin: "not a URL" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { origin: testConfig.baseUrl },
        })
      ).status,
    ).toBe(401);
  });

  it("enforces the configured Host allowlist for non-loopback deployments", async () => {
    const allowlistedRuntime = createHttpRuntime(
      {
        ...testConfig,
        host: "0.0.0.0",
        baseUrl: "https://mcp.example.com",
        allowedHosts: ["mcp.example.com"],
      },
      { version: "0.0.0-test" },
    );
    const baseUrl = await start(allowlistedRuntime.app);

    expect(await requestWithHost(`${baseUrl}/healthz`, "mcp.example.com")).toBe(200);
    expect(await requestWithHost(`${baseUrl}/healthz`, "mcp.example.com:8443")).toBe(200);
    expect(await requestWithHost(`${baseUrl}/healthz`, "attacker.example")).toBe(403);
  });

  it("adds defensive headers to public legal pages", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/legal/privacy`);
    const html = await response.text();
    const inlineStyle = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    if (!inlineStyle) throw new Error("Expected inline legal-page styles");
    const styleHash = createHash("sha256").update(inlineStyle, "utf8").digest("base64");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain(`'sha256-${styleHash}'`);
    expect(response.headers.get("content-security-policy")).not.toContain("'unsafe-inline'");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("media-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("public video range streaming", () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));
  const fixtureSize = statSync(fixturePath).size;

  async function startVideoServer(): Promise<string> {
    const videoApp = express();
    videoApp.get("/file", rateLimit({ windowMs: 60_000, limit: 100 }), (req, res) =>
      streamPublicVideo(req, res, fixturePath),
    );
    return start(videoApp);
  }

  it("serves explicit and suffix byte ranges", async () => {
    const baseUrl = await startVideoServer();
    const complete = await fetch(`${baseUrl}/file`);
    expect(complete.status).toBe(200);
    expect(complete.headers.get("vary")).toContain("Range");
    await complete.arrayBuffer();

    const explicit = await fetch(`${baseUrl}/file`, { headers: { range: "bytes=0-3" } });
    expect(explicit.status).toBe(206);
    expect(explicit.headers.get("content-range")).toBe(`bytes 0-3/${fixtureSize}`);
    expect(explicit.headers.get("vary")).toContain("Range");
    expect(explicit.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(explicit.headers.get("x-frame-options")).toBe("DENY");
    expect((await explicit.arrayBuffer()).byteLength).toBe(4);

    const suffix = await fetch(`${baseUrl}/file`, { headers: { range: "bytes=-5" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(
      `bytes ${fixtureSize - 5}-${fixtureSize - 1}/${fixtureSize}`,
    );
    expect((await suffix.arrayBuffer()).byteLength).toBe(5);

    const openEnded = await fetch(`${baseUrl}/file`, { headers: { range: "bytes=0-" } });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get("content-range")).toBe(
      `bytes 0-${fixtureSize - 1}/${fixtureSize}`,
    );
    expect((await openEnded.arrayBuffer()).byteLength).toBe(fixtureSize);

    const overlong = await fetch(`${baseUrl}/file`, {
      headers: { range: `bytes=0-${fixtureSize + 100}` },
    });
    expect(overlong.status).toBe(206);
    expect(overlong.headers.get("content-range")).toBe(`bytes 0-${fixtureSize - 1}/${fixtureSize}`);
    expect((await overlong.arrayBuffer()).byteLength).toBe(fixtureSize);
  });

  it("rejects malformed and unsatisfiable ranges", async () => {
    const baseUrl = await startVideoServer();
    for (const range of [
      "bytes=5-2",
      `bytes=${fixtureSize}-`,
      "bytes=-",
      "bytes=-0",
      "bytes=0-1,2-3",
      "items=0-1",
      "bytes=99999999999999999999-",
    ]) {
      const response = await fetch(`${baseUrl}/file`, { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${fixtureSize}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toContain("Range");
    }
  });

  it("adds defensive headers when the configured video file is missing", async () => {
    const videoApp = express();
    videoApp.get("/file", rateLimit({ windowMs: 60_000, limit: 100 }), (req, res) =>
      streamPublicVideo(req, res, "/definitely/missing/video.mp4"),
    );
    const baseUrl = await start(videoApp);
    const response = await fetch(`${baseUrl}/file`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns 404 when the configured path is not a regular file", async () => {
    const videoApp = express();
    videoApp.get("/file", rateLimit({ windowMs: 60_000, limit: 100 }), (req, res) =>
      streamPublicVideo(req, res, process.cwd()),
    );
    const baseUrl = await start(videoApp);

    expect((await fetch(`${baseUrl}/file`)).status).toBe(404);
  });

  it("returns 404 when the configured video file is empty", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "qurl-empty-video-test-"));
    const emptyFile = join(tempDir, "empty.mp4");
    writeFileSync(emptyFile, "");
    const videoApp = express();
    videoApp.get("/file", rateLimit({ windowMs: 60_000, limit: 100 }), (req, res) =>
      streamPublicVideo(req, res, emptyFile),
    );

    try {
      const baseUrl = await start(videoApp);
      expect((await fetch(`${baseUrl}/file`)).status).toBe(404);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("destroys the response when the video stream fails after inspection", async () => {
    const streamErrorRuntime = createHttpRuntime(testConfig, {
      version: "0.0.0-test",
      fileStreamFactory: () => {
        const stream = new PassThrough();
        globalThis.queueMicrotask(() => stream.destroy(new Error("video read failed")));
        return stream as unknown as ReadStream;
      },
    });
    const videoApp = express();
    videoApp.get("/file", rateLimit({ windowMs: 60_000, limit: 100 }), (req, res) =>
      streamErrorRuntime.streamPublicVideo(req, res, fixturePath),
    );
    const baseUrl = await start(videoApp);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      fetch(`${baseUrl}/file`).then((response) => response.arrayBuffer()),
    ).rejects.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("video read failed"));
  });
});
