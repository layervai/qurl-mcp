import { describe, it, expect, vi } from "vitest";
import { batchCreateTool, batchCreateSchema } from "../../tools/batch-create.js";
import { makeMockClient } from "../helpers.js";

const fixture = {
  succeeded: 2,
  failed: 0,
  results: [
    { index: 0, success: true, resource_id: "r_abc", qurl_link: "https://qurl.link/at_1" },
    { index: 1, success: true, resource_id: "r_def", qurl_link: "https://qurl.link/at_2" },
  ],
};

describe("batchCreateTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = batchCreateTool(makeMockClient());
      expect(tool.name).toBe("batch_create_qurls");
    });

    it("has a description", () => {
      const tool = batchCreateTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description).toContain("multiple");
    });
  });

  describe("schema", () => {
    it("requires items array", () => {
      const result = batchCreateSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty items array", () => {
      const result = batchCreateSchema.safeParse({ items: [] });
      expect(result.success).toBe(false);
    });

    it("accepts single item", () => {
      const result = batchCreateSchema.safeParse({
        items: [{ target_url: "https://example.com" }],
      });
      expect(result.success).toBe(true);
    });

    it("accepts multiple items with optional fields", () => {
      const result = batchCreateSchema.safeParse({
        items: [
          { target_url: "https://app1.example.com", expires_in: "7d" },
          { target_url: "https://app2.example.com", one_time_use: true, label: "Test" },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("accepts items with session_duration, custom_domain, and access_policy", () => {
      const result = batchCreateSchema.safeParse({
        items: [
          {
            target_url: "https://example.com",
            session_duration: "1h",
            custom_domain: "app.example.com",
            access_policy: { geo_allowlist: ["US"] },
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects more than 100 items", () => {
      const items = Array.from({ length: 101 }, (_, i) => ({
        target_url: `https://example${i}.com`,
      }));
      const result = batchCreateSchema.safeParse({ items });
      expect(result.success).toBe(false);
    });

    it("validates each item requires target_url", () => {
      const result = batchCreateSchema.safeParse({
        items: [{ label: "No URL" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.batchCreate with items", async () => {
      const mockBatch = vi
        .fn()
        .mockResolvedValue({ data: fixture, meta: { request_id: "req_batch" } });
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const input = {
        items: [
          { target_url: "https://app1.example.com" },
          { target_url: "https://app2.example.com" },
        ],
      };
      await tool.handler(input);

      expect(mockBatch).toHaveBeenCalledWith(input);
    });

    it("returns batch results as formatted JSON and does not set isError on full success", async () => {
      const mockBatch = vi
        .fn()
        .mockResolvedValue({ data: fixture, meta: { request_id: "req_batch1" } });
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const result = await tool.handler({
        items: [{ target_url: "https://example.com" }],
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.isError).toBe(false);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.succeeded).toBe(2);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.request_id).toBe("req_batch1");
    });

    it("surfaces partial failures with isError=true", async () => {
      const partialFixture = {
        succeeded: 1,
        failed: 1,
        results: [
          { index: 0, success: true, resource_id: "r_abc" },
          { index: 1, success: false, error: { code: "invalid_target_url", message: "Invalid URL" } },
        ],
      };
      const mockBatch = vi.fn().mockResolvedValue({
        data: partialFixture,
        meta: { request_id: "req_batch2" },
      });
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const result = await tool.handler({
        items: [
          { target_url: "https://valid.example.com" },
          { target_url: "https://invalid.example.com" },
        ],
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.failed).toBe(1);
      expect(parsed.results[1].error.code).toBe("invalid_target_url");
      expect(parsed.request_id).toBe("req_batch2");
    });

    it("handles missing request_id gracefully", async () => {
      const mockBatch = vi.fn().mockResolvedValue({ data: fixture, meta: {} });
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const result = await tool.handler({
        items: [{ target_url: "https://example.com" }],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.request_id).toBeUndefined();
    });

    it("surfaces all-items-failed (HTTP 400) as isError with per-item details", async () => {
      // Matches the API contract at qurl/internal/api/handlers/server.go:1126 —
      // a 400 here still carries a BatchCreateResponse body with per-item errors.
      const allFailed = {
        succeeded: 0,
        failed: 2,
        results: [
          {
            index: 0,
            success: false,
            error: { code: "invalid_input", message: "items[0]: target_url must be HTTPS" },
          },
          {
            index: 1,
            success: false,
            error: { code: "invalid_input", message: "items[1]: target_url must be HTTPS" },
          },
        ],
      };
      const mockBatch = vi
        .fn()
        .mockResolvedValue({ data: allFailed, meta: { request_id: "req_allfail" } });
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const result = await tool.handler({
        items: [
          { target_url: "http://a.example.com" },
          { target_url: "http://b.example.com" },
        ],
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.failed).toBe(2);
      expect(parsed.succeeded).toBe(0);
      expect(parsed.results[0].error.message).toContain("target_url must be HTTPS");
      expect(parsed.request_id).toBe("req_allfail");
    });

    it("propagates client errors", async () => {
      const mockBatch = vi.fn().mockRejectedValue(new Error("Rate limited"));
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      await expect(
        tool.handler({ items: [{ target_url: "https://example.com" }] }),
      ).rejects.toThrow("Rate limited");
    });

    it("surfaces isError=true on unexpected response shape (defense-in-depth)", async () => {
      // Simulates an HTTP 400 pass-through where the body is not a
      // BatchCreateResponse (e.g., a top-level validation error that slipped
      // through). The handler should flag it rather than crash on data.failed.
      const mockBatch = vi
        .fn()
        // Cast through unknown to simulate a runtime contract violation
        // without fighting the TypeScript types (which assume the contract).
        .mockResolvedValue({ data: undefined, meta: {} } as unknown);
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const result = await tool.handler({
        items: [{ target_url: "https://example.com" }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unexpected batchCreate response shape");
    });
  });
});
