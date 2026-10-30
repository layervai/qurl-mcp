import { createServer as createNodeServer, type Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  OAUTH_API_AUDIENCE,
  OAUTH_CLIENT_ID,
} from "../auth/hosted-oauth.js";
import { createHttpRuntime } from "../http.js";
import type { HttpServerConfig } from "../http-config.js";
import { makeMockClient, sampleShareCRIDOutput } from "./helpers.js";

const jwks = vi.hoisted(() => ({ key: undefined as JWTVerifyGetKey | undefined }));
vi.mock("jose", async (actual) => ({
  ...(await actual<typeof import("jose")>()),
  createRemoteJWKSet:
    () =>
    (...args: Parameters<JWTVerifyGetKey>) =>
      jwks.key!(...args),
}));
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let listener: Server | undefined;
let client: Client | undefined;
let runtime: ReturnType<typeof createHttpRuntime> | undefined;
const realFetch = globalThis.fetch;
const config: HttpServerConfig = {
  port: 3000,
  host: "127.0.0.1",
  baseUrl: "https://mcp.connector.layerv.ai",
  trustProxyHops: 0,
  stateless: true,
  hostedOAuth: true,
  oauthClientSecret: "fixture-client-secret",
  maxConcurrentRequests: 2,
  maxSessions: 100,
  maxSessionsPerCredential: 10,
  maxUnvalidatedSessions: 20,
  sessionIdleTtlMs: 900_000,
  sessionAbsoluteTtlMs: 86_400_000,
  unvalidatedSessionTtlMs: 60_000,
  mcpRateLimitPerMinute: 10_000,
  publicFileRateLimitPerMinute: 10_000,
  maxUploadFileDataBytes: 1024,
  defaultQurlApiUrl: OAUTH_API_AUDIENCE,
  defaultQurlConnectorUrl: "https://connector.example",
};
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks.key = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "fixture" }],
  });
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await runtime?.closeAllSessions();
  runtime = undefined;
  listener?.closeAllConnections();
  if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
  listener = undefined;
  vi.unstubAllGlobals();
});
async function token(downstream = false, scope = "qurl:read", subject = "auth0|customer-a") {
  return new SignJWT({
    azp: downstream ? OAUTH_CLIENT_ID : "openai-client",
    scope,
    "https://layerv.ai/email_verified": true,
    ...(downstream ? { act: { sub: OAUTH_CLIENT_ID }, permissions: ["qurl:admin"] } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setSubject(subject)
    .setIssuer(OAUTH_ISSUER)
    .setAudience(downstream ? OAUTH_API_AUDIENCE : OAUTH_RESOURCE)
    .setExpirationTime("5m")
    .sign(privateKey);
}
async function start(clientFactory?: Parameters<typeof createHttpRuntime>[1]["clientFactory"]) {
  runtime = createHttpRuntime(config, { version: "oauth-fixture", clientFactory });
  listener = createNodeServer(runtime.app);
  await new Promise<void>((resolve) => listener!.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("TCP listener missing");
  return `http://127.0.0.1:${address.port}`;
}

describe("hosted OAuth HTTP boundary", () => {
  it("publishes resource discovery and challenges unauthenticated callers without exchange", async () => {
    const exchange = vi.fn();
    vi.stubGlobal("fetch", exchange);
    const base = await start();
    const metadata = await (
      await realFetch(`${base}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    expect(metadata).toMatchObject({
      resource: OAUTH_RESOURCE,
      authorization_servers: [OAUTH_ISSUER],
    });
    const denied = await realFetch(`${base}/mcp`, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(denied.headers.get("www-authenticate")).not.toContain("error=");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("runs signed OAuth through the real MCP transport, forwards only token B and denies a write", async () => {
    const input = await token();
    const output = await token(true);
    const exchange = vi.fn(async () =>
      Response.json({
        access_token: output,
        token_type: "Bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    );
    vi.stubGlobal("fetch", exchange);
    const mock = makeMockClient({
      listQURLs: vi.fn(async () => ({ data: [], meta: { has_more: false } })),
      listConsumerInvitations: vi.fn(async () => ({ invitations: [], has_more: false })),
    });
    const factory = vi.fn((_token: string) => mock);
    const base = await start(factory);
    client = new Client({ name: "oauth-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: realFetch,
        requestInit: { headers: { authorization: `Bearer ${input}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(19);
    for (const tool of tools) {
      if (!tool.annotations?.readOnlyHint)
        expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
    }
    expect(tools.some((tool) => tool.name === "upload_file_qurl")).toBe(false);
    expect(tools.find((tool) => tool.name === "delete_qurl")?._meta?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["qurl:write"] },
    ]);
    const read = await client.callTool({ name: "list_qurls", arguments: {} });
    expect(read.isError).not.toBe(true);
    const invitations = await client.callTool({
      name: "list_crid_access",
      arguments: { action: "list_invitations", resource_id: "r_abcdefghijk" },
    });
    expect(invitations.isError).not.toBe(true);
    expect(mock.listConsumerInvitations).toHaveBeenCalledTimes(1);
    const accessWriter = tools.find((tool) => tool.name === "manage_crid_access")!;
    expect(accessWriter._meta?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["qurl:write"] },
    ]);
    expect((accessWriter.inputSchema.properties?.action as { enum: string[] }).enum).not.toContain(
      "list_invitations",
    );
    expect(tools.find((tool) => tool.name === "list_crid_access")?.annotations?.readOnlyHint).toBe(
      true,
    );
    const deniedInvite = await client.callTool({
      name: "manage_crid_access",
      arguments: { action: "invite", resource_id: "r_abcdefghijk", email: "recipient@example.com" },
    });
    expect(deniedInvite.isError).toBe(true);
    expect(mock.inviteConsumer).not.toHaveBeenCalled();
    const denied = await client.callTool({
      name: "delete_qurl",
      arguments: { resource_id: "r_abcdefghijk" },
    });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('scope="qurl:write"'),
    ]);
    expect(mock.deleteQURL).not.toHaveBeenCalled();
    expect(factory.mock.calls.every((args) => args[0] === output)).toBe(true);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("allows a scoped write but denies access listing with a write-only token", async () => {
    const input = await token(false, "qurl:write");
    const output = await token(true, "qurl:write");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: output,
          token_type: "Bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      ),
    );
    const mock = makeMockClient({
      inviteConsumer: vi.fn(async () => ({
        id: "a".repeat(64),
        email: "recipient@example.com",
        status: "sent",
        delivery: "accepted",
        version: 1,
        expires_at: "2026-10-31T00:00:00Z",
      })),
    });
    const base = await start(() => mock);
    client = new Client({ name: "oauth-write-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: realFetch,
        requestInit: { headers: { authorization: `Bearer ${input}` } },
      }),
    );
    const denied = await client.callTool({
      name: "list_crid_access",
      arguments: { action: "list_grants", resource_id: "r_abcdefghijk" },
    });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('scope="qurl:read"'),
    ]);
    expect(mock.listConsumerGrants).not.toHaveBeenCalled();
    const invited = await client.callTool({
      name: "manage_crid_access",
      arguments: { action: "invite", resource_id: "r_abcdefghijk", email: "recipient@example.com" },
    });
    expect(invited.isError).not.toBe(true);
    expect(mock.inviteConsumer).toHaveBeenCalledWith("r_abcdefghijk", "recipient@example.com");
  });

  it("fails closed on unsupported mode, resource URL or missing secret", () => {
    for (const overrides of [
      { stateless: false },
      { baseUrl: "https://other.example" },
      { defaultQurlApiUrl: "https://other.example" },
      { oauthClientSecret: undefined },
    ]) {
      expect(() => createHttpRuntime({ ...config, ...overrides }, { version: "test" })).toThrow();
    }
  });

  it("does not forward provider failures or another user's delegated token", async () => {
    const input = await token();
    const exchange = vi
      .fn()
      .mockResolvedValueOnce(new Response("private-provider-diagnostic", { status: 403 }))
      .mockResolvedValueOnce(new Response("private-provider-diagnostic", { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: await token(true, "qurl:read", "auth0|other"),
          token_type: "Bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      );
    vi.stubGlobal("fetch", exchange);
    const factory = vi.fn(() => makeMockClient());
    const base = await start(factory);
    for (const status of [401, 503, 401]) {
      const result = await realFetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${input}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(result.status).toBe(status);
      expect(await result.text()).not.toContain("private-provider-diagnostic");
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("returns retryable outages without asking the user to relink", async () => {
    const input = await token();
    const exchange = vi.fn(async () => {
      throw new TypeError("fetch failed: private diagnostics");
    });
    vi.stubGlobal("fetch", exchange);
    const base = await start();
    const send = () =>
      realFetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${input}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    let result = await send();
    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBe("1");
    expect(result.headers.get("www-authenticate")).toBeNull();
    expect(await result.text()).not.toContain("private diagnostics");
    const original = jwks.key;
    try {
      jwks.key = async () => {
        throw new errors.JWKSTimeout();
      };
      result = await send();
      expect(result.status).toBe(503);
      expect(result.headers.get("retry-after")).toBe("1");
      expect(result.headers.get("www-authenticate")).toBeNull();
    } finally {
      jwks.key = original;
    }
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("permits a write-scoped tool while denying read resources and resolve", async () => {
    const input = await token(false, "qurl:write");
    const output = await token(true, "qurl:write");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: output,
          token_type: "Bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      ),
    );
    const mock = makeMockClient();
    const base = await start(() => mock);
    client = new Client({ name: "write-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: realFetch,
        requestInit: { headers: { authorization: `Bearer ${input}` } },
      }),
    );
    const result = await client.callTool({
      name: "delete_qurl",
      arguments: { resource_id: "r_abcdefghijk" },
    });
    expect(result.isError).not.toBe(true);
    expect(mock.deleteQURL).toHaveBeenCalledWith("r_abcdefghijk");
    await expect(client.readResource({ uri: "qurl://links" })).rejects.toThrow("qurl:read");
    expect(mock.listQURLs).not.toHaveBeenCalled();
    const denied = await client.callTool({
      name: "resolve_qurl",
      arguments: { access_token: "at_fixture" },
    });
    expect(denied.isError).toBe(true);
    expect(mock.resolveQURL).not.toHaveBeenCalled();
    const extend = await client.callTool({
      name: "extend_qurl",
      arguments: { resource_id: "r_abcdefghijk", extend_by: "1h" },
    });
    expect(extend.isError).toBe(true);
    expect(extend._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('scope="qurl:write qurl:read"'),
    ]);
    expect(mock.getQURL).not.toHaveBeenCalled();
  });

  it("allows a resolve-only account to share a known CRID", async () => {
    const input = await token(false, "qurl:resolve");
    const output = await token(true, "qurl:resolve");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: output,
          token_type: "Bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      ),
    );
    const mock = makeMockClient({
      shareByCRID: vi.fn(async () => ({ data: sampleShareCRIDOutput() })),
    });
    const base = await start(() => mock);
    client = new Client({ name: "resolve-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: realFetch,
        requestInit: { headers: { authorization: `Bearer ${input}` } },
      }),
    );
    const result = await client.callTool({
      name: "share_by_crid",
      arguments: { crid: "crid_fixture" },
    });
    expect(result.isError).not.toBe(true);
    expect(mock.shareByCRID).toHaveBeenCalledWith("crid_fixture", undefined);
  });

  it("bounds pending exchanges before expensive work and releases request permits", async () => {
    const input = await token();
    const output = await token(true);
    let release!: (value: Response) => void;
    const exchange = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", exchange);
    const base = await start();
    const send = (options?: Parameters<typeof realFetch>[1]) =>
      realFetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        ...options,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      });
    const controller = new globalThis.AbortController();
    const first = send({ signal: controller.signal }).catch((error: unknown) => error);
    const second = send();
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runtime!.getInFlightRequestCount()).toBe(2));
    controller.abort();
    expect(await first).toBeInstanceOf(Error);
    const rejected = await send();
    expect(rejected.status).toBe(503);
    release(
      Response.json({
        access_token: output,
        token_type: "Bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    );
    expect((await second).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});
