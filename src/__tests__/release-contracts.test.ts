import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { QURLClient } from "../client.js";
import { deleteQurlSchema } from "../tools/delete-qurl.js";
import { runWithRequestAuthContext } from "../auth/request-context.js";
import {
  getConnectorConfig,
  mintUploadedFile,
  uploadToConnector,
} from "../tools/upload-file-shared.js";
import { withMissingApiKeyHandler } from "../tools/_shared.js";
import { createServer } from "../server.js";
import { resourceIdSchema, resourceOnlyIdSchema } from "../tools/_shared.js";
import { accessPolicySchema } from "../tools/create-qurl.js";
import { batchCreateSchema } from "../tools/batch-create.js";
import {
  makeMockClient,
  mockConnectorFetch,
  sampleAccessToken,
  sampleCreateQURLData,
  sampleQURL,
  sampleMintLinkOutput,
} from "./helpers.js";

const publicKey =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA";
const crid = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
const extra = { crid, target_path: "/docs", future_field: { version: 2 } };
const resource = { ...sampleQURL(), ...extra };
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});

async function connect() {
  const api = makeMockClient({
    createQURL: vi.fn().mockResolvedValue({ data: { ...sampleCreateQURLData(), ...extra } }),
    getQURL: vi.fn().mockResolvedValue({ data: resource }),
    listQURLs: vi
      .fn()
      .mockResolvedValue({ data: [resource], meta: { has_more: false, future_cursor: "x" } }),
    updateQURL: vi.fn().mockResolvedValue({ data: resource }),
    updateQurlToken: vi.fn().mockResolvedValue({ data: sampleAccessToken() }),
    mintLink: vi.fn().mockResolvedValue({ data: { ...sampleMintLinkOutput(), ...extra } }),
  });
  const server = createServer(api, "test");
  const client = new Client({ name: "release-regression", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  close.push(
    () => client.close(),
    () => server.close(),
  );
  await client.listTools(); // Cache output schemas, enabling official client validation.
  return { client, api };
}

describe("release contract regressions", () => {
  it.each([
    ["create_qurl", { target_url: "https://example.com" }],
    ["get_qurl", { resource_id: "r_abcdefghijk" }],
    ["list_qurls", {}],
    ["update_qurl", { resource_id: "r_abcdefghijk", extend_by: "1h" }],
    ["extend_qurl", { resource_id: "r_abcdefghijk", extend_by: "1h", qurl_id: "q_aaaaaaaaaaa" }],
    ["mint_link", { resource_id: "r_abcdefghijk" }],
  ])("preserves new API fields through official MCP client: %s", async (name, args) => {
    const { client } = await connect();
    const result = await client.callTool({
      name: name as string,
      arguments: args as Record<string, unknown>,
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    const data = name === "list_qurls" ? (structured.data as unknown[])[0] : structured;
    expect(data).toMatchObject(extra);
  });

  it.each([publicKey, crid, "a".repeat(47), "a".repeat(107), "a".repeat(214), "r_abcdefghijk"])(
    "accepts API resource identifier %s",
    (id) => {
      expect(resourceOnlyIdSchema("delete").safeParse(id).success).toBe(true);
      expect(deleteQurlSchema.safeParse({ resource_id: id }).success).toBe(true);
      expect(resourceIdSchema("get").safeParse(id).success).toBe(true);
    },
  );
  it.each([
    "",
    "../secret",
    "x/y",
    "x?admin",
    "x#fragment",
    "a".repeat(106),
    "a".repeat(113),
    "a".repeat(215),
    "A".repeat(109),
    "q_123456789ab",
  ])("rejects invalid resource-only identifier %s", (id) => {
    expect(resourceOnlyIdSchema("delete").safeParse(id).success).toBe(false);
  });

  it("does not advertise or forward batch email_delivery", () => {
    expect(batchCreateSchema.shape.items.element.shape).not.toHaveProperty("email_delivery");
    const parsed = batchCreateSchema.parse({
      items: [{ target_url: "https://example.com", email_delivery: { to: ["a@example.com"] } }],
    });
    expect(parsed.items[0]).not.toHaveProperty("email_delivery");
  });

  it.each([
    ["ip_allowlist", 100],
    ["ip_denylist", 100],
    ["geo_allowlist", 50],
    ["geo_denylist", 50],
  ] as const)("enforces API %s limit", (field, limit) => {
    expect(accessPolicySchema.safeParse({ [field]: Array(limit).fill("US") }).success).toBe(true);
    expect(accessPolicySchema.safeParse({ [field]: Array(limit + 1).fill("US") }).success).toBe(
      false,
    );
  });
  it.each(["allow_categories", "deny_categories"])("enforces API %s category limit", (field) => {
    expect(
      accessPolicySchema.safeParse({ ai_agent_policy: { [field]: Array(21).fill("gptbot") } })
        .success,
    ).toBe(false);
  });
});

describe("resource SDK boundary", () => {
  it("preserves the legacy resource deletion route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await new QURLClient({
      apiKey: "lv_test_release",
      baseURL: "https://api.example.com",
    }).deleteQURL("r_abcdefghijk");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/qurls/r_abcdefghijk",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it.each([publicKey, crid])("accepts current connector resource IDs: %s", async (id) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ resource_id: id }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await uploadToConnector(new Uint8Array([1]), "a.pdf", "application/pdf", {
      apiKey: "lv_test_release",
      uploadUrl: "https://connector.example.com/api/upload",
    });
    expect(result.resource_id).toBe(id);
  });

  it.each([publicKey, crid])(
    "deletes current resource IDs through the real SDK: %s",
    async (id) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      const api = new QURLClient({ apiKey: "lv_test_release", baseURL: "https://api.example.com" });
      await api.deleteQURL(id);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.example.com/v1/resources/${id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
    },
  );

  it.each([
    ["https://connector.test/api/upload", "https://connector.test/api/mint_link/"],
    ["https://host.test/connector/api/upload", "https://host.test/connector/api/mint_link/"],
  ])("mints beside the upload route of %s", async (uploadUrl, mintPrefix) => {
    const fetchMock = mockConnectorFetch();
    vi.stubGlobal("fetch", fetchMock);
    await mintUploadedFile(
      { apiKey: "lv_live_test", uploadUrl },
      publicKey,
      { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
      {},
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${mintPrefix}${publicKey}`);
  });

  it.each([
    {
      description: "an upload URL without the /api/upload route",
      uploadUrl: "https://c.test/x",
      options: {},
    },
    {
      description: "an expires_in the duration grammar rejects",
      uploadUrl: "https://c.test/api/upload",
      options: { expires_in: "banana" },
    },
  ])("fails before minting given $description", async ({ uploadUrl, options }) => {
    const fetchMock = mockConnectorFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      mintUploadedFile(
        { apiKey: "lv_live_test", uploadUrl },
        publicKey,
        { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
        options,
      ),
    ).rejects.toSatisfy(
      (error: { code?: string; message?: string }) =>
        error.code === "upload_mint_failed" &&
        // Nothing reached the connector, so no link can exist.
        !error.message?.includes("may already have been minted"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a JSON mint body without Content-Type and reports only a confirmed expiry", async () => {
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(
        undefined,
        // A byte body carries no Content-Type, unlike a string body.
        () =>
          new Response(
            Buffer.from(
              JSON.stringify({
                success: true,
                links: [{ qurl_id: "q_123456789ab", qurl_link: "https://l" }],
              }),
            ),
          ),
      ),
    );
    const fetchMock = vi.mocked(globalThis.fetch);
    const before = Date.now();
    const result = await mintUploadedFile(
      { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
      publicKey,
      { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
      { expires_in: "2h" },
    );
    // The requested expiry is exact on the wire...
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { expires_at: string };
    const lifetime = Date.parse(sent.expires_at) - before;
    expect(lifetime).toBeGreaterThanOrEqual(7_200_000);
    expect(lifetime).toBeLessThan(7_200_000 + 60_000);
    // ...but an unconfirmed expiry is never reported as fact.
    expect(result.qurl_link).toBe("https://l");
    expect(result.expires_at).toBeUndefined();
    expect(result.requested_expires_at).toBe(sent.expires_at);
    expect(result.expires_at_unconfirmed).toBe(true);
  });

  it("accepts a plain-HTTP link only from a loopback development connector", async () => {
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () =>
        Response.json({
          success: true,
          links: [{ qurl_id: "q_123456789ab", qurl_link: "http://127.0.0.1:8080/views/x" }],
        }),
      ),
    );
    const result = await mintUploadedFile(
      { apiKey: "lv_live_test", uploadUrl: "http://127.0.0.1:8080/api/upload" },
      publicKey,
      { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
      {},
    );
    expect(result.qurl_link).toBe("http://127.0.0.1:8080/views/x");
  });

  it("rejects a plain-HTTP loopback link from a non-loopback connector", async () => {
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () =>
        Response.json({
          success: true,
          links: [{ qurl_id: "q_123456789ab", qurl_link: "http://127.0.0.1:8080/views/x" }],
        }),
      ),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      mintUploadedFile(
        { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
        publicKey,
        { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
        {},
      ),
    ).rejects.toMatchObject({ code: "upload_mint_failed" });
    // The refused link is live, so the operator log names it.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("q_123456789ab"));
  });

  it("sends session_duration, logs extra links and expiry drift, and keeps an unconfirmed expiry separate", async () => {
    const fetchMock = mockConnectorFetch(undefined, () =>
      Response.json({
        success: true,
        links: [
          { qurl_id: "q_123456789ab", qurl_link: "https://l", expires_at: "2000-01-01T00:00:00Z" },
          { qurl_id: "q_0000000000a", qurl_link: "https://m" },
          { qurl_link: "https://n" },
          { qurl_id: "not-a-qurl", qurl_link: "https://o" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await mintUploadedFile(
      { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
      publicKey,
      { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
      { expires_in: "2h", session_duration: "15m" },
    );
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ n: 1, one_time_use: true, session_duration: "15m" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("minted 4 links"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not the requested"));
    expect(result.expires_at).toBe("2000-01-01T00:00:00.000Z");
    expect(result.requested_expires_at).toBe(sent.expires_at);
    // The extra live link reaches the caller, not only stderr.
    expect(result.unexpected_extra_link_count).toBe(3);
    expect(result.expires_at_differs_from_request).toBe(true);
    expect(result.unexpected_extra_qurl_ids).toEqual(["q_0000000000a"]);
    expect(sent).toBeDefined();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  it("keeps a 2xx failure reason for operators and bounds an oversized mint response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const response of [
      () => Response.json({ success: false, error: "quota exceeded" }),
      () => Response.json({ success: false, error: "tunnel unavailable" }, { status: 502 }),
      () =>
        new Response("x".repeat(64 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
    ]) {
      vi.stubGlobal("fetch", mockConnectorFetch(undefined, response));
      await expect(
        mintUploadedFile(
          { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
          publicKey,
          { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
          {},
        ),
      ).rejects.toMatchObject({ code: "upload_mint_failed" });
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining("quota exceeded"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("tunnel unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("64 KiB"));
  });

  it("normalizes a loosely formatted connector expiry to ISO 8601", async () => {
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () =>
        Response.json({
          success: true,
          links: [
            { qurl_id: "q_123456789ab", qurl_link: "https://l", expires_at: "Dec 31 2026 UTC" },
          ],
        }),
      ),
    );
    const result = await mintUploadedFile(
      { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
      publicKey,
      { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
      {},
    );
    expect(result.expires_at).toBe("2026-12-31T00:00:00.000Z");
  });

  it.each([
    { cause: "ECONNREFUSED", hedged: false },
    { cause: "ECONNRESET", hedged: true },
  ])(
    "hedges about an existing link only when a $cause request may have arrived",
    async ({ cause, hedged }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error(cause), { code: cause }),
          });
        }),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const error = await mintUploadedFile(
        { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
        publicKey,
        { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
        {},
      ).catch((caught: Error) => caught);
      expect(String((error as Error).message).includes("may already have been minted")).toBe(
        hedged,
      );
    },
  );

  it("names a malformed minted qurl_id in the operator log and rejects an unparsable session_duration", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () =>
        Response.json({ success: true, links: [{ qurl_id: "bad\nid", qurl_link: "https://l" }] }),
      ),
    );
    const config = { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" };
    const file = { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 };
    await expect(mintUploadedFile(config, publicKey, file, {})).rejects.toMatchObject({
      code: "upload_mint_failed",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("links: bad id"));

    // A usable link after an unusable first one is returned, not discarded.
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () =>
        Response.json({
          success: true,
          links: [
            { qurl_link: "https://x" },
            { qurl_id: "q_0000000000a", qurl_link: "https://real" },
          ],
        }),
      ),
    );
    const recovered = await mintUploadedFile(config, publicKey, file, {});
    expect(recovered).toMatchObject({
      qurl_id: "q_0000000000a",
      qurl_link: "https://real",
      unexpected_extra_link_count: 1,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(no qurl_id), q_0000000000a"));

    // When no entry is deliverable, the caller still learns which live links exist.
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () =>
        Response.json({
          success: true,
          links: [{ qurl_id: "q_0000000000b", qurl_link: "http://example.test/x" }],
        }),
      ),
    );
    const refused = await mintUploadedFile(config, publicKey, file, {}).catch(
      (error: Error) => error,
    );
    expect(refused).toMatchObject({ code: "upload_mint_failed" });
    expect((refused as Error).message).toContain("q_0000000000b; tell the user");

    const fetchMock = mockConnectorFetch();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      mintUploadedFile(config, publicKey, file, { session_duration: "1 hour" }),
    ).rejects.toMatchObject({ code: "upload_mint_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds the returned extra link IDs while counting all of them", async () => {
    const links = Array.from({ length: 30 }, (_, index) => ({
      qurl_id: `q_${index.toString(16).padStart(11, "0")}`,
      qurl_link: "https://l",
    }));
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () => Response.json({ success: true, links })),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await mintUploadedFile(
      { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
      publicKey,
      { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
      {},
    );
    expect(result.unexpected_extra_link_count).toBe(29);
    expect(result.unexpected_extra_qurl_ids).toHaveLength(10);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(+20 more)"));
  });

  it("reports live links named in a failed mint response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const response of [
      () =>
        Response.json(
          { success: false, error: "downstream failed", links: [{ qurl_id: "q_000000000c1" }] },
          { status: 502 },
        ),
      () => Response.json({ success: false, links: [{ qurl_id: "q_000000000c2" }] }),
    ]) {
      vi.stubGlobal("fetch", mockConnectorFetch(undefined, response));
      const error = await mintUploadedFile(
        { apiKey: "lv_live_test", uploadUrl: "https://c.test/api/upload" },
        publicKey,
        { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
        {},
      ).catch((caught: Error) => caught);
      expect((error as Error).message).toMatch(/q_000000000c[12]; tell the user/);
    }
  });

  it("forwards the request-scoped bearer, not the server key, to the connector mint", async () => {
    const fetchMock = mockConnectorFetch();
    vi.stubGlobal("fetch", fetchMock);
    await runWithRequestAuthContext(
      { qurlApiKey: "lv_live_caller", qurlConnectorUrl: "https://c.test" },
      () =>
        mintUploadedFile(
          getConnectorConfig(),
          publicKey,
          { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
          {},
        ),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer lv_live_caller");
  });

  it("returns the uploaded resource ID to the caller when mint fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, () =>
        Response.json(
          { success: false, error: "private upstream error", links: [] },
          { status: 503 },
        ),
      ),
    );
    const handler = withMissingApiKeyHandler(async () => {
      const data = await mintUploadedFile(
        { apiKey: "lv_live_test", uploadUrl: "https://connector.test/api/upload" },
        publicKey,
        { name: "a.pdf", contentType: "application/pdf", sizeBytes: 12 },
        {},
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    });
    const result = await handler(undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(publicKey);
    expect(result.content[0].text).toContain("retrying uploads another copy");
    expect(result.content[0].text).not.toContain("private upstream error");
  });
});

describe("configured tool discovery", () => {
  it("does not read operator configuration in the server factory", async () => {
    vi.stubEnv("QURL_CONNECTOR_URL", "not a URL");
    try {
      await createServer(makeMockClient(), "test").close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["stdio", "http"] as const)(
    "hides unconfigured upload/email features in %s",
    async (mode) => {
      const server = createServer(makeMockClient(), "test", mode, undefined, {
        uploads: false,
        email: false,
      });
      const client = new Client({ name: "discovery", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      close.push(
        () => client.close(),
        () => server.close(),
      );
      const { tools } = await client.listTools();
      expect(tools.filter((tool) => tool.name.startsWith("upload_"))).toHaveLength(0);
      for (const tool of tools)
        expect(tool.inputSchema.properties).not.toHaveProperty("email_delivery");
    },
  );
});
