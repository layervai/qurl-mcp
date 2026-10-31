import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigCache, loadRuntimeConfig } from "../config.js";
import { uploadFileDataQurlTool } from "../tools/upload-file-data-qurl.js";
import { sendEmailMessage } from "../services/email.js";
import { getConnectorConfig, mintUploadedFile } from "../tools/upload-file-shared.js";
import { connectorMintedLink, makeMockClient, mockConnectorFetch } from "./helpers.js";

vi.mock("../services/email.js", () => ({ sendEmailMessage: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRuntimeConfigCache();
});

it("passes the operator host allowlist through upload preflight", () => {
  vi.stubEnv("QURL_LINK_HOSTS", "qurl.link");
  vi.stubEnv("QURL_API_KEY", "lv_test");
  vi.stubEnv("QURL_CONNECTOR_URL", "https://connector.test");
  expect(getConnectorConfig(true)).toMatchObject({ linkHosts: ["qurl.link"] });
});

it("refreshes the policy when the environment changes", () => {
  vi.stubEnv("QURL_LINK_HOSTS", "QURL.LINK,qurl.link, files.example");
  expect(loadRuntimeConfig().linkHosts).toEqual(["qurl.link", "files.example"]);
  vi.stubEnv("QURL_LINK_HOSTS", "replacement.example");
  expect(loadRuntimeConfig().linkHosts).toEqual(["replacement.example"]);
});

it.each([
  "https://qurl.link",
  "qurl.link:443",
  "*.qurl.link",
  "user@qurl.link",
  "qurl.link/path",
  "qurl.link?x",
  "qurl.link#x",
])("rejects invalid host policy %s before upload", (value) => {
  vi.stubEnv("QURL_LINK_HOSTS", value);
  vi.stubEnv("QURL_API_KEY", "lv_test");
  vi.stubEnv("QURL_CONNECTOR_URL", "https://connector.test");
  expect(() => getConnectorConfig(true)).toThrow("QURL_LINK_HOSTS/linkHosts");
});

it("bounds policy size", () => {
  vi.stubEnv("QURL_LINK_HOSTS", Array(1001).fill("qurl.link").join(","));
  expect(() => loadRuntimeConfig()).toThrow("at most 1000");
});

for (const [url, allowed] of [
  ["https://qurl.link/#at_fixture", true],
  ["https://QURL.LINK/#at_fixture", true],
  ["https://evil.example/#at_fixture", false],
  ["https://qurl.link.evil.example/#at_fixture", false],
  ["https://evil.qurl.link/#at_fixture", false],
  ["https://qurl.link@evil.example/#at_fixture", false],
] as const) {
  it(`checks the returned hostname: ${url}`, async () => {
    vi.stubEnv("QURL_LINK_HOSTS", "qurl.link");
    vi.stubEnv("QURL_API_KEY", "lv_test");
    vi.stubEnv("QURL_CONNECTOR_URL", "https://connector.test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, (body) =>
        Response.json({
          success: true,
          links: [{ ...connectorMintedLink, qurl_link: url, expires_at: body.expires_at }],
        }),
      ),
    );
    const result = mintUploadedFile(
      getConnectorConfig(true),
      "r_upload12345",
      { name: "fixture.pdf", contentType: "application/pdf", sizeBytes: 10 },
      {},
    );
    if (allowed) await expect(result).resolves.toMatchObject({ qurl_link: url });
    else
      await expect(result).rejects.toMatchObject({
        code: "upload_mint_failed",
        message: expect.stringContaining("not permitted by QURL_LINK_HOSTS/linkHosts"),
      });
  });
}

it("preserves unconfigured custom-domain links", async () => {
  vi.stubEnv("QURL_LINK_HOSTS", "");
  vi.stubGlobal(
    "fetch",
    mockConnectorFetch(undefined, (body) =>
      Response.json({
        success: true,
        links: [
          {
            ...connectorMintedLink,
            qurl_link: "https://custom.example/#at_fixture",
            expires_at: body.expires_at,
          },
        ],
      }),
    ),
  );
  const result = await mintUploadedFile(
    { apiKey: "lv_test", uploadUrl: "https://connector.test/api/upload" },
    "r_upload12345",
    { name: "fixture.pdf", contentType: "application/pdf", sizeBytes: 10 },
    {},
  );
  expect(result.qurl_link).toBe("https://custom.example/#at_fixture");
});

it.each([false, 0, ["qurl.link", false]])(
  "rejects malformed config-file policies: %j",
  (linkHosts) => {
    const dir = mkdtempSync(join(tmpdir(), "qurl-link-hosts-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({ linkHosts }));
      vi.stubEnv("QURL_LINK_HOSTS", undefined);
      expect(() => loadRuntimeConfig(path)).toThrow("QURL_LINK_HOSTS/linkHosts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("loads the config-file policy and honors an environment override", () => {
  const dir = mkdtempSync(join(tmpdir(), "qurl-link-hosts-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ linkHosts: ["QURL.LINK", "files.example"] }));
    vi.stubEnv("QURL_LINK_HOSTS", undefined);
    expect(loadRuntimeConfig(path).linkHosts).toEqual(["qurl.link", "files.example"]);
    vi.stubEnv("QURL_LINK_HOSTS", "override.example");
    expect(loadRuntimeConfig(path).linkHosts).toEqual(["override.example"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("never emails an upload link from a rejected host", async () => {
  vi.stubEnv("QURL_LINK_HOSTS", "qurl.link");
  vi.stubEnv("QURL_API_KEY", "lv_test");
  vi.stubEnv("QURL_CONNECTOR_URL", "https://connector.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    mockConnectorFetch(undefined, (body) =>
      Response.json({
        success: true,
        links: [
          {
            ...connectorMintedLink,
            qurl_link: "https://evil.example/#at_fixture",
            expires_at: body.expires_at,
          },
        ],
      }),
    ),
  );
  const tool = uploadFileDataQurlTool(makeMockClient(), { mode: "stdio" });
  await expect(
    tool.handler({
      file_base64: readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)).toString(
        "base64",
      ),
      file_name: "sample.pdf",
      content_type: "application/pdf",
      email_delivery: { to: ["alice@example.com"] },
    }),
  ).resolves.toMatchObject({
    isError: true,
    content: [
      { type: "text", text: expect.stringContaining("not permitted by QURL_LINK_HOSTS/linkHosts") },
    ],
  });
  expect(sendEmailMessage).not.toHaveBeenCalled();
});

it("selects an allowed replacement and reports rejected live extras by ID only", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    mockConnectorFetch(undefined, (body) =>
      Response.json({
        success: true,
        links: [
          {
            ...connectorMintedLink,
            qurl_id: "q_rejected",
            qurl_link: "https://evil.example/#at_fixture",
            expires_at: body.expires_at,
          },
          { ...connectorMintedLink, qurl_id: "q_allowed", expires_at: body.expires_at },
        ],
      }),
    ),
  );
  const result = await mintUploadedFile(
    { apiKey: "lv_test", uploadUrl: "https://connector.test/api/upload", linkHosts: ["qurl.link"] },
    "r_upload12345",
    { name: "fixture.pdf", contentType: "application/pdf", sizeBytes: 10 },
    {},
  );
  expect(result).toMatchObject({
    qurl_link: connectorMintedLink.qurl_link,
    unexpected_extra_link_count: 1,
    unexpected_extra_qurl_ids: ["q_rejected"],
  });
  expect(JSON.stringify(result)).not.toContain("evil.example");
});

it.each(["127.0.0.1", "[::1]"])(
  "keeps an explicitly permitted loopback development link: %s",
  async (host) => {
    vi.stubEnv("QURL_LINK_HOSTS", host);
    vi.stubEnv("QURL_API_KEY", "lv_test");
    vi.stubEnv("QURL_CONNECTOR_URL", "http://127.0.0.1:8080");
    const link = `http://${host}/#at_fixture`;
    vi.stubGlobal(
      "fetch",
      mockConnectorFetch(undefined, (body) =>
        Response.json({
          success: true,
          links: [{ ...connectorMintedLink, qurl_link: link, expires_at: body.expires_at }],
        }),
      ),
    );
    const result = await mintUploadedFile(
      getConnectorConfig(true),
      "r_upload12345",
      { name: "fixture.pdf", contentType: "application/pdf", sizeBytes: 10 },
      {},
    );
    expect(result.qurl_link).toBe(link);
  },
);

it.each(["", "   ", ",,,"])(
  "does not disable a file policy with an empty environment list: %j",
  (value) => {
    const dir = mkdtempSync(join(tmpdir(), "qurl-link-hosts-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({ linkHosts: ["qurl.link"] }));
      vi.stubEnv("QURL_LINK_HOSTS", value);
      expect(loadRuntimeConfig(path).linkHosts).toEqual(["qurl.link"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
