import { describe, it, expect, vi } from "vitest";
import { getQurlTool, getQurlSchema } from "../../tools/get-qurl.js";
import { makeMockClient, sampleQurlData } from "../helpers.js";

const fixture = sampleQurlData({
  resource_id: "r_test456",
  qurl_site: "https://test.qurl.site",
  target_url: "https://example.com/page",
  description: "A test link",
  expires_at: "2026-03-15T00:00:00Z",
  tags: ["test"],
});

describe("getQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = getQurlTool(makeMockClient());
      expect(tool.name).toBe("get_qurl");
    });

    it("has a description mentioning resource ID", () => {
      const tool = getQurlTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description).toContain("resource ID");
    });
  });

  describe("schema", () => {
    it("requires resource_id", () => {
      const result = getQurlSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts valid resource_id string", () => {
      const result = getQurlSchema.safeParse({ resource_id: "r_abc123" });
      expect(result.success).toBe(true);
    });

    it("rejects non-string resource_id", () => {
      const result = getQurlSchema.safeParse({ resource_id: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.getQURL with resource_id and returns data", async () => {
      const mockGet = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ getQURL: mockGet });
      const tool = getQurlTool(client);

      const result = await tool.handler({ resource_id: "r_test456" });

      expect(mockGet).toHaveBeenCalledWith("r_test456");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe("r_test456");
      expect(parsed.target_url).toBe("https://example.com/page");
      expect(parsed.tags).toEqual(["test"]);
    });

    it("returns only the data object, not the wrapper", async () => {
      const mockGet = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ getQURL: mockGet });
      const tool = getQurlTool(client);

      const result = await tool.handler({ resource_id: "r_test456" });
      const text = result.content[0].text;

      // Should be the QurlData object directly, not { data: ... }
      expect(text).toBe(JSON.stringify(fixture));
    });

    it("propagates client errors", async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error("Not found"));
      const client = makeMockClient({ getQURL: mockGet });
      const tool = getQurlTool(client);

      await expect(tool.handler({ resource_id: "r_nope" })).rejects.toThrow("Not found");
    });
  });
});
