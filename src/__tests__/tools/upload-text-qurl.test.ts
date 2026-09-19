import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectorMintBody,
  connectorMintedLink,
  makeMockClient,
  mockConnectorFetch,
} from "../helpers.js";
import {
  uploadTextQurlSchema,
  uploadTextQurlTool as uploadTextQurlToolFactory,
} from "../../tools/upload-text-qurl.js";

vi.mock("../../services/email.js", () => ({
  sendEmailMessage: vi.fn(),
}));

const uploadTextQurlTool = (
  client: Parameters<typeof uploadTextQurlToolFactory>[0],
  runtime: Parameters<typeof uploadTextQurlToolFactory>[1] = { mode: "stdio" },
) => uploadTextQurlToolFactory(client, runtime);

const cleanupSpy = vi.fn().mockResolvedValue(undefined);
const fixturePath = resolve("src/__tests__/fixtures/sample.pdf");
const fixtureSize = statSync(fixturePath).size;

vi.mock("../../services/text-pdf.js", () => ({
  MAX_TEXT_PDF_CONTENT_BYTES: 256 * 1024,
  MAX_TEXT_PDF_CONTENT_CHARACTERS: 100_000,
  createTextPdfTempFile: vi
    .fn()
    .mockImplementation(async ({ fileName }: { fileName?: string }) => ({
      cleanup: cleanupSpy,
      fileName: fileName?.replace(/\.[^.]+$/, ".pdf") ?? "content.pdf",
      filePath: fixturePath,
      sizeBytes: fixtureSize,
    })),
}));

import { sendEmailMessage } from "../../services/email.js";
import { createTextPdfTempFile } from "../../services/text-pdf.js";

describe("uploadTextQurlTool", () => {
  const originalApiKey = process.env.QURL_API_KEY;
  const originalConnectorUrl = process.env.QURL_CONNECTOR_URL;
  const originalConfigPath = process.env.QURL_MCP_CONFIG;
  const originalFetch = globalThis.fetch;
  let tempDir: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    cleanupSpy.mockClear();
    tempDir = mkdtempSync(join(tmpdir(), "qurl-upload-text-test-"));
    const generatedFixturePath = join(tempDir, "generated.pdf");
    copyFileSync(fixturePath, generatedFixturePath);
    vi.mocked(createTextPdfTempFile).mockImplementation(
      async ({ fileName }: { fileName?: string }) => ({
        cleanup: cleanupSpy,
        fileName: fileName?.replace(/\.[^.]+$/, ".pdf") ?? "content.pdf",
        filePath: generatedFixturePath,
        sizeBytes: fixtureSize,
      }),
    );
    process.env.QURL_API_KEY = "lv_live_test";
    process.env.QURL_CONNECTOR_URL = "https://connector.test";
    delete process.env.QURL_MCP_CONFIG;
  });

  afterEach(() => {
    process.env.QURL_API_KEY = originalApiKey;
    process.env.QURL_CONNECTOR_URL = originalConnectorUrl;
    process.env.QURL_MCP_CONFIG = originalConfigPath;
    globalThis.fetch = originalFetch;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  describe("schema", () => {
    it("accepts a minimal text upload request", () => {
      const result = uploadTextQurlSchema.safeParse({
        type: "markdown",
        content: "hello world",
      });
      expect(result.success).toBe(true);
    });

    it("accepts supported payload types", () => {
      const result = uploadTextQurlSchema.safeParse({
        type: "json",
        content: '{"ok":true}',
        file_name: "data.json",
      });
      expect(result.success).toBe(true);
    });

    it("rejects an empty upload label", () => {
      expect(
        uploadTextQurlSchema.safeParse({ type: "text", content: "hello", label: "" }).success,
      ).toBe(false);
    });
  });

  describe("handler", () => {
    it("renders a PDF, uploads it, mints the link through the connector, and returns a structured result", async () => {
      const fetchMock = mockConnectorFetch();
      globalThis.fetch = fetchMock;
      const tool = uploadTextQurlTool(makeMockClient());

      const result = await tool.handler({
        type: "markdown",
        content: "hello world",
        file_name: "hello.json",
        label: "Text Share",
        expires_in: "2h",
        one_time_use: false,
        session_duration: "1h",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [uploadUrl, uploadInit] = fetchMock.mock.calls[0]!;
      expect(uploadUrl).toBe("https://connector.test/api/upload");
      expect(uploadInit?.headers).toEqual(
        expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer lv_live_test",
        }),
      );
      const form = uploadInit?.body as globalThis.FormData;
      const blob = form.get("file") as globalThis.File;
      expect(blob.type).toBe("application/pdf");
      expect(blob.name).toBe("hello.pdf");
      expect(blob.size).toBe(fixtureSize);
      expect(createTextPdfTempFile).toHaveBeenCalledWith({
        content: "hello world",
        fileName: "hello.json",
        title: "Text Share",
      });
      const mint = connectorMintBody(fetchMock);
      expect(mint.url).toBe("https://connector.test/api/mint_link/r_upload12345");
      expect(mint.body).toEqual({
        n: 1,
        one_time_use: false,
        expires_at: expect.any(String),
        session_duration: "1h",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        resource_id: "r_upload12345",
        ...connectorMintedLink,
        content_type: "application/pdf",
        file_name: "hello.pdf",
        size_bytes: fixtureSize,
      });
      expect(cleanupSpy).toHaveBeenCalledOnce();
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });

    it("defaults file_name to content.pdf", async () => {
      globalThis.fetch = mockConnectorFetch();

      const tool = uploadTextQurlTool(makeMockClient());

      const result = await tool.handler({
        type: "markdown",
        content: "# Hello",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.content_type).toBe("application/pdf");
      expect(parsed.file_name).toBe("content.pdf");
      expect(createTextPdfTempFile).toHaveBeenCalledWith({
        content: "# Hello",
        fileName: "content.pdf",
        title: "content.pdf",
      });
      expect(cleanupSpy).toHaveBeenCalledOnce();
    });

    it("emails the generated text link when email_delivery is provided", async () => {
      globalThis.fetch = mockConnectorFetch();
      vi.mocked(sendEmailMessage).mockResolvedValue({
        attempted: true,
        enabled: true,
        recipients: ["alice@example.com"],
        sent: 1,
        failed: 0,
        results: [
          { email: "alice@example.com", success: true, skipped: false, message_id: "msg-1" },
        ],
      });

      const tool = uploadTextQurlTool(makeMockClient());

      const result = await tool.handler({
        type: "markdown",
        content: "hello world",
        file_name: "hello.pdf",
        email_delivery: {
          to: ["alice@example.com"],
        },
      });

      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.email_delivery?.sent).toBe(1);
      expect(cleanupSpy).toHaveBeenCalledOnce();
    });

    it("still returns success when temp cleanup fails after a successful upload", async () => {
      globalThis.fetch = mockConnectorFetch();
      cleanupSpy.mockRejectedValueOnce(new Error("cleanup failed"));

      const tool = uploadTextQurlTool(makeMockClient());

      const result = await tool.handler({
        type: "markdown",
        content: "hello world",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.qurl_id).toBe(connectorMintedLink.qurl_id);
      expect(parsed.file_name).toBe("content.pdf");
      expect(cleanupSpy).toHaveBeenCalledOnce();
    });

    it("returns isError when QURL_API_KEY is missing", async () => {
      delete process.env.QURL_API_KEY;
      const configPath = join(tempDir!, "qurl-mcp.config.json");
      writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://api.layerv.ai" }));
      process.env.QURL_MCP_CONFIG = configPath;
      const tool = uploadTextQurlTool(makeMockClient());

      const result = await tool.handler({
        type: "markdown",
        content: "hello world",
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
      expect(cleanupSpy).not.toHaveBeenCalled();
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

      const tool = uploadTextQurlTool(makeMockClient());

      await expect(
        tool.handler({
          type: "markdown",
          content: "hello world",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "connector_upload_failed",
        message: "upload rejected",
      });
      expect(cleanupSpy).toHaveBeenCalledOnce();
    });
  });
});
