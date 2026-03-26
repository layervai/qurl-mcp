import { describe, it, expect, vi } from "vitest";
import { updateQurlTool, updateQurlSchema } from "../../tools/update-qurl.js";
import { makeMockClient, sampleQurlData } from "../helpers.js";

const fixture = sampleQurlData({
  resource_id: "r_update1",
  qurl_site: "https://update.qurl.site",
  target_url: "https://example.com/updated",
  expires_at: "2026-04-09T00:00:00Z",
  tags: ["prod"],
});

describe("updateQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = updateQurlTool(makeMockClient());
      expect(tool.name).toBe("update_qurl");
    });

    it("has a description mentioning expiration", () => {
      const tool = updateQurlTool(makeMockClient());
      expect(tool.description).toContain("expiration");
    });
  });

  describe("schema", () => {
    it("requires resource_id", () => {
      expect(updateQurlSchema.safeParse({}).success).toBe(false);
    });

    it("accepts resource_id with extend_by", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        extend_by: "24h",
      });
      expect(result.success).toBe(true);
    });

    it("accepts resource_id with expires_at", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(true);
    });

    it("accepts tags and description", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        tags: ["prod", "api"],
        description: "Updated description",
      });
      expect(result.success).toBe(true);
    });

    it("rejects non-string extend_by", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        extend_by: 24,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.updateQURL with resource_id and body", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      await tool.handler({ resource_id: "r_update1", extend_by: "48h" });

      expect(mockUpdate).toHaveBeenCalledWith("r_update1", { extend_by: "48h" });
    });

    it("returns updated QURL data as formatted JSON", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      const result = await tool.handler({ resource_id: "r_update1", extend_by: "48h" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe("r_update1");
      expect(parsed.expires_at).toBe("2026-04-09T00:00:00Z");
    });

    it("returns only the data object, not the wrapper", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      const result = await tool.handler({ resource_id: "r_update1", extend_by: "24h" });
      expect(result.content[0].text).toBe(JSON.stringify(fixture));
    });

    it("passes tags and description to client", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      await tool.handler({
        resource_id: "r_update1",
        tags: ["prod", "api"],
        description: "New desc",
      });

      expect(mockUpdate).toHaveBeenCalledWith("r_update1", {
        tags: ["prod", "api"],
        description: "New desc",
      });
    });

    it("propagates client errors", async () => {
      const mockUpdate = vi.fn().mockRejectedValue(new Error("QURL expired"));
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      await expect(
        tool.handler({ resource_id: "r_expired", extend_by: "24h" }),
      ).rejects.toThrow("QURL expired");
    });
  });
});
