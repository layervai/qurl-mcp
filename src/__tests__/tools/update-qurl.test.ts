import { describe, it, expect, vi } from "vitest";
import { updateQurlTool, updateQurlSchema } from "../../tools/update-qurl.js";
import { makeMockClient, sampleQURL } from "../helpers.js";

const fixture = sampleQURL({
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

    it("rejects more than 10 tags", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
      });
      expect(result.success).toBe(false);
    });

    it("rejects tags longer than 50 characters", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        tags: ["x".repeat(51)],
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty tag strings", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        tags: [""],
      });
      expect(result.success).toBe(false);
    });

    it("rejects tags that don't match the API pattern", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        tags: ["-invalid"], // must start with alphanumeric
      });
      expect(result.success).toBe(false);
    });

    it("rejects description longer than 500 characters", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        description: "x".repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string extend_by", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        extend_by: 24,
      });
      expect(result.success).toBe(false);
    });

    it("rejects both extend_by and expires_at", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
        extend_by: "24h",
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) => i.message === "Provide either extend_by or expires_at, not both",
          ),
        ).toBe(true);
      }
    });

    it("rejects update with no update fields", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: "r_abc",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) =>
              i.message ===
              "At least one update field (extend_by, expires_at, tags, or description) is required",
          ),
        ).toBe(true);
      }
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

    it("returns isError response when both extend_by and expires_at are provided", async () => {
      const mockUpdate = vi.fn();
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      const result = await tool.handler({
        resource_id: "r_abc",
        extend_by: "24h",
        expires_at: "2026-04-01T00:00:00Z",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("extend_by or expires_at");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("returns isError response when no update fields are provided", async () => {
      const mockUpdate = vi.fn();
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      const result = await tool.handler({ resource_id: "r_abc" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("At least one update field");
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
