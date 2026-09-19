import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { QURLClient } from "../client.js";
import { deleteQurlSchema } from "../tools/delete-qurl.js";
import { mintUploadedFile, uploadToConnector } from "../tools/upload-file-shared.js";
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
    ).rejects.toMatchObject({ code: "upload_mint_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
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
