import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigCache } from "../../config.js";
import {
  connectorMintBody,
  connectorMintedLink,
  makeMockClient,
  mockConnectorFetch,
} from "../helpers.js";
import {
  readFileWithinLimit,
  uploadGeneratedFileAndMint,
  uploadFileQurlSchema,
  uploadFileQurlTool as uploadFileQurlToolFactory,
} from "../../tools/upload-file-qurl.js";

vi.mock("../../services/email.js", () => ({
  sendEmailMessage: vi.fn(),
}));

import { sendEmailMessage } from "../../services/email.js";

const uploadFileQurlTool = (
  client: Parameters<typeof uploadFileQurlToolFactory>[0],
  runtime: Parameters<typeof uploadFileQurlToolFactory>[1] = { mode: "stdio" },
) => uploadFileQurlToolFactory(client, runtime);

const fixturePath = resolve("src/__tests__/fixtures/sample.pdf");

describe("uploadFileQurlTool", () => {
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
    tempDir = mkdtempSync(join(tmpdir(), "qurl-upload-file-test-"));
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
    it("accepts a minimal file upload request", () => {
      const result = uploadFileQurlSchema.safeParse({ file_path: fixturePath });
      expect(result.success).toBe(true);
      expect(uploadFileQurlSchema.shape.content_type.description).toContain(
        "must match the filename extension",
      );
      expect(uploadFileQurlSchema.shape.content_type.description).not.toContain("override");
    });

    it("rejects unsupported content_type overrides", () => {
      const result = uploadFileQurlSchema.safeParse({
        file_path: fixturePath,
        content_type: "image/svg+xml",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("rejects generated-file helper paths outside the server temporary directory", async () => {
      await expect(
        uploadGeneratedFileAndMint(
          { file_path: fixturePath },
          { uploadUrl: "https://connector.test/api/upload", apiKey: "lv_live_test" },
        ),
      ).rejects.toThrow("must remain inside the server temporary directory");
    });

    it("rejects a file that grows beyond the limit after its initial stat", async () => {
      const filePath = join(tempDir!, "growing.pdf");
      writeFileSync(filePath, "%PDF-");
      const fileHandle = await open(filePath, "r+");
      const initialSize = (await fileHandle.stat()).size;
      await fileHandle.write("x".repeat(32), initialSize, "utf8");

      try {
        await expect(readFileWithinLimit(fileHandle, 8, initialSize)).rejects.toThrow(
          "configured upload size limit",
        );
      } finally {
        await fileHandle.close();
      }
    });

    it("uploads the file, mints the link through the connector, and returns a structured result", async () => {
      // The fixture confirms a different expiry than requested: the clamp log path.
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchMock = mockConnectorFetch();
      globalThis.fetch = fetchMock;
      const mintLink = vi.fn();
      const tool = uploadFileQurlTool(makeMockClient({ mintLink }));

      const result = await tool.handler({
        file_path: fixturePath,
        label: "Share PDF",
        expires_in: "2h",
        session_duration: "15m",
      });

      // Regression (qurl-mcp#278): the upload resource's own qURL is not a
      // viewable page, so the link must come from the connector's mint route.
      expect(mintLink).not.toHaveBeenCalled();
      const mint = connectorMintBody(fetchMock);
      expect(mint.url).toBe("https://connector.test/api/mint_link/r_upload12345");
      expect(mint.init?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer lv_live_test" }),
      );
      expect(mint.body).toEqual({
        n: 1,
        one_time_use: true,
        expires_at: expect.any(String),
        session_duration: "15m",
      });
      const lifetimeMs = Date.parse(mint.body.expires_at) - Date.now();
      expect(lifetimeMs).toBeGreaterThan(2 * 3_600_000 - 60_000);
      expect(lifetimeMs).toBeLessThanOrEqual(2 * 3_600_000);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        resource_id: "r_upload12345",
        ...connectorMintedLink,
        // The connector echoes the requested expiry: the normal, flag-free shape.
        expires_at: mint.body.expires_at,
        requested_expires_at: mint.body.expires_at,
        content_type: "application/pdf",
        file_name: "sample.pdf",
        size_bytes: expect.any(Number),
      });
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("not the requested"));
    });

    it("emails the generated local-file link when requested", async () => {
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
      const tool = uploadFileQurlTool(makeMockClient());

      const result = await tool.handler({
        file_path: fixturePath,
        email_delivery: { to: ["alice@example.com"] },
      });

      expect(sendEmailMessage).toHaveBeenCalledOnce();
      expect(JSON.parse(result.content[0].text).email_delivery).toEqual(
        expect.objectContaining({ sent: 1, failed: 0 }),
      );
    });

    it("returns isError when QURL_API_KEY is missing", async () => {
      delete process.env.QURL_API_KEY;
      const configPath = join(tempDir!, "qurl-mcp.config.json");
      writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://api.layerv.ai" }));
      process.env.QURL_MCP_CONFIG = configPath;
      const tool = uploadFileQurlTool(makeMockClient());

      const result = await tool.handler({ file_path: fixturePath });

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

    it("rejects local files that exceed the configured upload limit", async () => {
      process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES = "16b";
      globalThis.fetch = vi.fn();
      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: fixturePath })).rejects.toThrow(
        "File exceeds the configured upload size limit",
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects an empty local file before contacting the connector", async () => {
      const emptyPath = join(tempDir!, "empty.pdf");
      writeFileSync(emptyPath, "");
      globalThis.fetch = vi.fn();
      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: emptyPath })).rejects.toThrow("File is empty");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("does not use the server API key fallback when invoked in HTTP mode", async () => {
      globalThis.fetch = vi.fn();
      const tool = uploadFileQurlTool(makeMockClient(), { mode: "http" });

      await expect(tool.handler({ file_path: fixturePath })).rejects.toThrow(
        "available only in stdio mode",
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("rejects symbolic links instead of following them", async () => {
      const symlinkPath = join(tempDir!, "linked-sample.pdf");
      symlinkSync(fixturePath, symlinkPath);
      globalThis.fetch = vi.fn();
      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: symlinkPath })).rejects.toThrow("symbolic link");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("throws a typed error when the connector upload fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "connector_upload_failed",
              detail: `upload\r\nrejected${"x".repeat(2_000)}`,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: fixturePath })).rejects.toMatchObject({
        statusCode: 400,
        code: "connector_upload_failed",
        message: `Connector reported (HTTP 400): "upload rejected${"x".repeat(1_009)}"`,
      });
    });

    it("namespaces a connector's error code so it cannot pose as a local condition", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: "missing_api_key", detail: "nope" } }, { status: 401 }),
        );
      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: fixturePath })).rejects.toMatchObject({
        code: "connector_missing_api_key",
        message: 'Connector reported (HTTP 401): "nope"',
      });
    });

    it("rejects a successful connector response with a non-JSON content type", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ resource_id: "r_upload12345" }), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: fixturePath })).rejects.toMatchObject({
        statusCode: 0,
        code: "unexpected_response",
        message: "Connector upload succeeded with a non-JSON response.",
      });
    });

    it("distinguishes malformed connector resource IDs from missing fields", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ resource_id: "wrong-shape" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: fixturePath })).rejects.toMatchObject({
        code: "invalid_resource_id",
        message: "Connector upload returned a resource_id with an invalid format.",
      });
    });
  });
});
