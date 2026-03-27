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
      const mockBatch = vi.fn().mockResolvedValue({ data: fixture });
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

    it("returns batch results as formatted JSON", async () => {
      const mockBatch = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const result = await tool.handler({
        items: [{ target_url: "https://example.com" }],
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.succeeded).toBe(2);
      expect(parsed.results).toHaveLength(2);
    });

    it("returns partial failure results", async () => {
      const partialFixture = {
        succeeded: 1,
        failed: 1,
        results: [
          { index: 0, success: true, resource_id: "r_abc" },
          { index: 1, success: false, error: { code: "invalid_target_url", message: "Invalid URL" } },
        ],
      };
      const mockBatch = vi.fn().mockResolvedValue({ data: partialFixture });
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      const result = await tool.handler({
        items: [
          { target_url: "https://valid.example.com" },
          { target_url: "https://invalid.example.com" },
        ],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.failed).toBe(1);
      expect(parsed.results[1].error.code).toBe("invalid_target_url");
    });

    it("propagates client errors", async () => {
      const mockBatch = vi.fn().mockRejectedValue(new Error("Rate limited"));
      const client = makeMockClient({ batchCreate: mockBatch });
      const tool = batchCreateTool(client);

      await expect(
        tool.handler({ items: [{ target_url: "https://example.com" }] }),
      ).rejects.toThrow("Rate limited");
    });
  });
});
