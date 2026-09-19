import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigCache } from "../../config.js";
import {
  connectorMintBody,
  connectorMintedLink,
  makeMockClient,
  mockConnectorFetch,
} from "../helpers.js";
import {
  createUploadFileDataQurlSchema,
  maxBase64CharactersForBytes,
  uploadFileDataQurlSchema,
  uploadFileDataQurlTool as uploadFileDataQurlToolFactory,
} from "../../tools/upload-file-data-qurl.js";

vi.mock("../../services/email.js", () => ({
  sendEmailMessage: vi.fn(),
}));

import { sendEmailMessage } from "../../services/email.js";

const uploadFileDataQurlTool = (
  client: Parameters<typeof uploadFileDataQurlToolFactory>[0],
  runtime: Parameters<typeof uploadFileDataQurlToolFactory>[1] = { mode: "stdio" },
) => uploadFileDataQurlToolFactory(client, runtime);

const fixturePath = resolve("src/__tests__/fixtures/sample.pdf");
const fixtureBase64 = readFileSync(fixturePath).toString("base64");

describe("uploadFileDataQurlTool", () => {
  const originalApiKey = process.env.QURL_API_KEY;
  const originalConnectorUrl = process.env.QURL_CONNECTOR_URL;
  const originalConfigPath = process.env.QURL_MCP_CONFIG;
  const originalMaxUploadBytes = process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES;
  const originalFetch = globalThis.fetch;
  let tempDir: string | undefined;

  beforeEach(() => {
    clearRuntimeConfigCache();
    vi.restoreAllMocks();
    process.env.QURL_API_KEY = "lv_live_test";
    process.env.QURL_CONNECTOR_URL = "https://connector.test";
    delete process.env.QURL_MCP_CONFIG;
    delete process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES;
    tempDir = mkdtempSync(join(tmpdir(), "qurl-upload-file-data-test-"));
  });

  afterEach(() => {
    process.env.QURL_API_KEY = originalApiKey;
    process.env.QURL_CONNECTOR_URL = originalConnectorUrl;
    process.env.QURL_MCP_CONFIG = originalConfigPath;
    process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES = originalMaxUploadBytes;
    clearRuntimeConfigCache();
    globalThis.fetch = originalFetch;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  describe("schema", () => {
    it("accepts a minimal file-data upload request", () => {
      const result = uploadFileDataQurlSchema.safeParse({
        file_base64: fixtureBase64,
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });
      expect(result.success).toBe(true);
    });

    it("rejects unsupported content types", () => {
      const result = uploadFileDataQurlSchema.safeParse({
        file_base64: fixtureBase64,
        file_name: "sample.pdf",
        content_type: "image/svg+xml",
      });
      expect(result.success).toBe(false);
    });

    it("rejects base64 strings above the protocol-wide schema ceiling", () => {
      const boundedSchema = createUploadFileDataQurlSchema(8);
      const result = boundedSchema.safeParse({
        file_base64: "A".repeat(9),
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });

      expect(result.success).toBe(false);
    });

    it("registers the schema ceiling from the runtime decoded-byte limit", () => {
      const configuredBytes = 768;
      const tool = uploadFileDataQurlTool(makeMockClient(), {
        mode: "http",
        maxUploadFileDataBytes: configuredBytes,
      });
      const ceiling = maxBase64CharactersForBytes(configuredBytes);
      const input = {
        file_name: "sample.pdf",
        content_type: "application/pdf" as const,
      };

      expect(
        tool.inputSchema.safeParse({ ...input, file_base64: "A".repeat(ceiling) }).success,
      ).toBe(true);
      expect(
        tool.inputSchema.safeParse({ ...input, file_base64: "A".repeat(ceiling + 1) }).success,
      ).toBe(false);
    });
  });

  describe("handler", () => {
    it("validates connector configuration before decoding file data", async () => {
      process.env.QURL_CONNECTOR_URL = "http://connector.test";
      globalThis.fetch = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: "not base64!",
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("must use HTTPS");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("does not follow connector redirect responses", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
      );
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toMatchObject({ statusCode: 302 });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://connector.test/api/upload",
        expect.objectContaining({ redirect: "error" }),
      );
    });

    it("uploads base64 file data, mints the link through the connector, and returns a structured result", async () => {
      const fetchMock = mockConnectorFetch();
      globalThis.fetch = fetchMock;
      const mintLink = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient({ mintLink }));

      const result = await tool.handler({
        file_base64: fixtureBase64,
        file_name: "sample.pdf",
        content_type: "application/pdf",
        label: "Share PDF",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://connector.test/api/upload",
        expect.objectContaining({ redirect: "error" }),
      );
      expect(mintLink).not.toHaveBeenCalled();
      const mint = connectorMintBody(fetchMock);
      expect(mint.url).toBe("https://connector.test/api/mint_link/r_upload12345");
      expect(mint.init).toEqual(expect.objectContaining({ method: "POST", redirect: "error" }));
      expect(mint.init?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer lv_live_test" }),
      );
      expect(mint.body).toEqual({ n: 1, one_time_use: true });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        resource_id: "r_upload12345",
        ...connectorMintedLink,
        content_type: "application/pdf",
        file_name: "sample.pdf",
        size_bytes: expect.any(Number),
      });
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });

    it.each([
      {
        description: "an upstream error",
        response: () =>
          Response.json({ success: false, error: "upstream error", links: [] }, { status: 502 }),
      },
      {
        description: "a success without a link",
        response: () => Response.json({ success: true, links: [] }),
      },
      {
        description: "a link without its URL",
        response: () => Response.json({ success: true, links: [{ qurl_id: "q_123456789ab" }] }),
      },
      {
        description: "a non-HTTP link",
        response: () =>
          Response.json({
            success: true,
            links: [{ qurl_id: "q_123456789ab", qurl_link: "javascript:alert(1)" }],
          }),
      },
      {
        description: "a plain-HTTP link",
        response: () =>
          Response.json({
            success: true,
            links: [{ qurl_id: "q_123456789ab", qurl_link: "http://qurl.link/#x" }],
          }),
      },
      {
        description: "a 2xx that reports failure",
        response: () =>
          Response.json({ success: false, links: [{ qurl_id: "q_123456789ab", qurl_link: "x" }] }),
      },
      {
        description: "a 2xx non-JSON body",
        response: () =>
          new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } }),
      },
    ])(
      "reports the orphaned upload when the connector mint returns $description",
      async ({ response }) => {
        globalThis.fetch = mockConnectorFetch({ resource_id: "r_orphan12345" }, response);
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const tool = uploadFileDataQurlTool(makeMockClient());

        await expect(
          tool.handler({
            file_base64: fixtureBase64,
            file_name: "sample.pdf",
            content_type: "application/pdf",
          }),
        ).resolves.toMatchObject({
          isError: true,
          content: [{ type: "text", text: expect.stringContaining("r_orphan12345") }],
        });
        expect(log).toHaveBeenCalledWith(expect.stringContaining("r_orphan12345"));
      },
    );

    it("never attempts a mint when the upload itself fails", async () => {
      const fetchMock = mockConnectorFetch({ resource_id: "r_upload12345" });
      fetchMock.mockImplementationOnce(async () =>
        Response.json({ error: { code: "connector_upload_failed" } }, { status: 500 }),
      );
      globalThis.fetch = fetchMock;
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toMatchObject({ code: "connector_upload_failed" });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/upload$/);
    });

    it("accepts data URLs in file_base64", async () => {
      globalThis.fetch = mockConnectorFetch();

      const tool = uploadFileDataQurlTool(makeMockClient());

      const result = await tool.handler({
        file_base64: `data:application/pdf;base64,${fixtureBase64}`,
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.file_name).toBe("sample.pdf");

      const bareDataUrlResult = await tool.handler({
        file_base64: `data:;base64,${fixtureBase64}`,
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });
      expect(JSON.parse(bareDataUrlResult.content[0].text).file_name).toBe("sample.pdf");

      const parameterizedDataUrlResult = await tool.handler({
        file_base64: `data:application/pdf;charset=utf-8;base64,${fixtureBase64}`,
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });
      expect(JSON.parse(parameterizedDataUrlResult.content[0].text).file_name).toBe("sample.pdf");

      const whitespaceResult = await tool.handler({
        file_base64: fixtureBase64.replace(/(.{40})/g, "$1\n"),
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });
      expect(JSON.parse(whitespaceResult.content[0].text).file_name).toBe("sample.pdf");
    });

    it("rejects mismatched data URL, filename, and file signatures before upload", async () => {
      globalThis.fetch = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: `data:image/png;base64,${fixtureBase64}`,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("Data URL media type does not match content_type");
      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.png",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("does not match the filename extension");
      await expect(
        tool.handler({
          file_base64: Buffer.from("not a PDF").toString("base64"),
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("does not match declared content_type");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("accepts URL-safe base64 without padding", async () => {
      globalThis.fetch = mockConnectorFetch();

      const tool = uploadFileDataQurlTool(makeMockClient());

      const urlSafeBase64 = fixtureBase64
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");

      const result = await tool.handler({
        file_base64: urlSafeBase64,
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.file_name).toBe("sample.pdf");
    });

    it("rejects mixed standard and URL-safe base64 alphabets", async () => {
      globalThis.fetch = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: "AA+_",
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("valid base64-encoded content");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects impossible base64 padding lengths", async () => {
      globalThis.fetch = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: "A",
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("valid base64-encoded content");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("reports non-base64 data URLs explicitly", async () => {
      globalThis.fetch = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: "data:application/pdf,not-base64",
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("Only base64-encoded data URLs are supported");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("bounds data URL prefix parsing independently of the file payload ceiling", async () => {
      globalThis.fetch = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: `data:application/pdf;note=${"x".repeat(1024)};base64,${fixtureBase64}`,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("Only base64-encoded data URLs are supported");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("emails the generated file link when email_delivery is provided", async () => {
      globalThis.fetch = mockConnectorFetch();
      vi.mocked(sendEmailMessage).mockResolvedValue({
        attempted: true,
        enabled: true,
        recipients: ["alice@example.com", "bob@example.com"],
        sent: 2,
        failed: 0,
        results: [
          { email: "alice@example.com", success: true, skipped: false, message_id: "msg-1" },
          { email: "bob@example.com", success: true, skipped: false, message_id: "msg-2" },
        ],
      });

      const tool = uploadFileDataQurlTool(makeMockClient());

      const result = await tool.handler({
        file_base64: fixtureBase64,
        file_name: "sample.pdf",
        content_type: "application/pdf",
        email_delivery: {
          to: ["alice@example.com", "bob@example.com"],
          message: "Please review",
        },
      });

      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.email_delivery).toEqual({
        attempted: true,
        enabled: true,
        recipients: ["alice@example.com", "bob@example.com"],
        sent: 2,
        failed: 0,
        results: [
          { email: "alice@example.com", success: true, skipped: false, message_id: "msg-1" },
          { email: "bob@example.com", success: true, skipped: false, message_id: "msg-2" },
        ],
      });
    });

    it("returns isError when QURL_API_KEY is missing", async () => {
      delete process.env.QURL_API_KEY;
      const configPath = join(tempDir!, "qurl-mcp.config.json");
      writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://api.layerv.ai" }));
      process.env.QURL_MCP_CONFIG = configPath;
      const tool = uploadFileDataQurlTool(makeMockClient());

      const result = await tool.handler({
        file_base64: fixtureBase64,
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining("QURL_API_KEY is not set"),
          },
        ],
      });
    });

    it("never falls back to the server API key in HTTP mode", async () => {
      process.env.QURL_API_KEY = "lv_server_key_must_not_be_used";
      globalThis.fetch = vi.fn();
      const tool = uploadFileDataQurlTool(makeMockClient(), { mode: "http" });

      const result = await tool.handler({
        file_base64: fixtureBase64,
        file_name: "sample.pdf",
        content_type: "application/pdf",
      });

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining("QURL_API_KEY is not set"),
          },
        ],
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects files that exceed the configured decoded-size limit", async () => {
      process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES = "16b";
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toThrow("Decoded file exceeds the allowed upload size");
    });

    it("rejects connector responses above the 64 KiB cap", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("x".repeat(64 * 1024 + 1)));
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toMatchObject({ code: "connector_response_too_large" });
    });

    it.each([
      {
        name: "timeout",
        error: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
        code: "connector_timeout",
      },
      {
        name: "network failure",
        error: new Error("connection refused"),
        code: "connector_unreachable",
      },
    ])("maps connector $name without exposing fetch errors", async ({ error, code }) => {
      globalThis.fetch = vi.fn().mockRejectedValue(error);
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toMatchObject({ code, statusCode: 0 });
    });

    it("maps a timeout while reading connector response bytes", async () => {
      const abortError = Object.assign(new Error("response stalled"), { name: "AbortError" });
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          new globalThis.ReadableStream({
            pull(controller) {
              controller.error(abortError);
            },
          }),
          { status: 200 },
        ),
      );
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toMatchObject({ code: "connector_timeout", statusCode: 0 });
    });

    it("throws a typed error when the connector upload fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "connector_upload_failed", detail: "upload rejected" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "connector_upload_failed",
        message: "upload rejected",
      });
    });

    it("does not echo an unstructured connector error body", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response("upstream secret detail", { status: 502 }));
      const tool = uploadFileDataQurlTool(makeMockClient());

      await expect(
        tool.handler({
          file_base64: fixtureBase64,
          file_name: "sample.pdf",
          content_type: "application/pdf",
        }),
      ).rejects.toMatchObject({
        statusCode: 502,
        code: "connector_upload_failed",
        message: "Connector request failed with HTTP 502",
      });
    });
  });
});
