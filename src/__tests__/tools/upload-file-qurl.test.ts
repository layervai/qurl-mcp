import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { QURLAPIError } from "../../client.js";
import { clearRuntimeConfigCache } from "../../config.js";
import { makeMockClient } from "../helpers.js";
import {
  readFileWithinLimit,
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

    it("uploads the file, mints a qURL, and returns a structured result", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ resource_id: "r_upload12345" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const mintLink = vi.fn().mockResolvedValue({
        data: {
          qurl_id: "q_123456789ab",
          qurl_link: "https://qurl.link/#at_upload",
          expires_at: "2026-06-23T00:00:00Z",
          type: "transit",
        },
      });
      const getQURL = vi.fn().mockResolvedValue({
        data: {
          resource_id: "r_upload12345",
          status: "active",
          created_at: "2026-06-22T00:00:00Z",
          expires_at: "2026-06-23T00:00:00Z",
          qurl_site: "https://r_upload12345.qurl.site",
        },
      });
      const client = makeMockClient({ mintLink, getQURL });
      const tool = uploadFileQurlTool(client);

      const result = await tool.handler({ file_path: fixturePath, label: "Share PDF" });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(mintLink).toHaveBeenCalledWith(
        "r_upload12345",
        expect.objectContaining({
          label: "Share PDF",
          one_time_use: true,
        }),
      );
      expect(getQURL).toHaveBeenCalledWith("r_upload12345");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual(
        expect.objectContaining({
          resource_id: "r_upload12345",
          qurl_id: "q_123456789ab",
          qurl_link: "https://qurl.link/#at_upload",
          qurl_site: "https://r_upload12345.qurl.site",
          content_type: "application/pdf",
          file_name: "sample.pdf",
        }),
      );
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });

    it("continues when qurl_site enrichment is unavailable", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { resource_id: "r_upload12345" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const client = makeMockClient({
        mintLink: vi.fn().mockResolvedValue({
          data: {
            qurl_id: "q_123456789ab",
            qurl_link: "https://qurl.link/#at_upload",
            expires_at: "2026-06-23T00:00:00Z",
          },
        }),
        getQURL: vi.fn().mockRejectedValue(new Error("insufficient_scope")),
      });
      const tool = uploadFileQurlTool(client);

      const result = await tool.handler({ file_path: fixturePath });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.qurl_site).toBeUndefined();
    });

    it("emails the generated local-file link when requested", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ resource_id: "r_upload12345" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
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
      const tool = uploadFileQurlTool(
        makeMockClient({
          mintLink: vi.fn().mockResolvedValue({
            data: {
              qurl_id: "q_123456789ab",
              qurl_link: "https://qurl.link/#at_upload",
              expires_at: "2026-06-23T00:00:00Z",
            },
          }),
          getQURL: vi.fn().mockRejectedValue(new Error("insufficient_scope")),
        }),
      );

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
            error: { code: "connector_upload_failed", detail: "upload rejected" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );

      const tool = uploadFileQurlTool(makeMockClient());

      await expect(tool.handler({ file_path: fixturePath })).rejects.toMatchObject<QURLAPIError>({
        statusCode: 400,
        code: "connector_upload_failed",
        message: "upload rejected",
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

      await expect(tool.handler({ file_path: fixturePath })).rejects.toMatchObject<QURLAPIError>({
        code: "invalid_resource_id",
        message: "Connector upload returned a resource_id with an invalid format.",
      });
    });
  });
});
