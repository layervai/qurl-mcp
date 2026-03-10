import { describe, it, expect, vi } from "vitest";
import { extendQurlTool, extendQurlSchema } from "../../tools/extend-qurl.js";
import { makeMockClient, sampleQURL } from "../helpers.js";

const fixture = sampleQURL({
  resource_id: "r_extend1",
  qurl_link: "https://qurl.link/at_ext",
  qurl_site: "https://ext.qurl.site",
  target_url: "https://example.com/extended",
  expires_at: "2026-04-09T00:00:00Z",
  access_count: 3,
});

describe("extendQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = extendQurlTool(makeMockClient());
      expect(tool.name).toBe("extend_qurl");
    });

    it("has a description mentioning expiration", () => {
      const tool = extendQurlTool(makeMockClient());
      expect(tool.description).toContain("expiration");
    });
  });

  describe("schema", () => {
    it("requires both resource_id and extend_by", () => {
      expect(extendQurlSchema.safeParse({}).success).toBe(false);
      expect(extendQurlSchema.safeParse({ resource_id: "r_abc" }).success).toBe(false);
      expect(extendQurlSchema.safeParse({ extend_by: "24h" }).success).toBe(false);
    });

    it("accepts valid input", () => {
      const result = extendQurlSchema.safeParse({
        resource_id: "r_abc",
        extend_by: "24h",
      });
      expect(result.success).toBe(true);
    });

    it("rejects non-string extend_by", () => {
      const result = extendQurlSchema.safeParse({
        resource_id: "r_abc",
        extend_by: 24,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.extendQURL with resource_id and extend_by", async () => {
      const mockExtend = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ extendQURL: mockExtend });
      const tool = extendQurlTool(client);

      await tool.handler({ resource_id: "r_extend1", extend_by: "48h" });

      expect(mockExtend).toHaveBeenCalledWith("r_extend1", { extend_by: "48h" });
    });

    it("returns updated QURL data as formatted JSON", async () => {
      const mockExtend = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ extendQURL: mockExtend });
      const tool = extendQurlTool(client);

      const result = await tool.handler({ resource_id: "r_extend1", extend_by: "48h" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe("r_extend1");
      expect(parsed.expires_at).toBe("2026-04-09T00:00:00Z");
    });

    it("returns only the data object, not the wrapper", async () => {
      const mockExtend = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ extendQURL: mockExtend });
      const tool = extendQurlTool(client);

      const result = await tool.handler({ resource_id: "r_extend1", extend_by: "24h" });
      expect(result.content[0].text).toBe(JSON.stringify(fixture, null, 2));
    });

    it("propagates client errors", async () => {
      const mockExtend = vi.fn().mockRejectedValue(new Error("QURL expired"));
      const client = makeMockClient({ extendQURL: mockExtend });
      const tool = extendQurlTool(client);

      await expect(
        tool.handler({ resource_id: "r_expired", extend_by: "24h" }),
      ).rejects.toThrow("QURL expired");
    });
  });
});
