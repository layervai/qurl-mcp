import { describe, it, expect, vi } from "vitest";
import { QURLAPIError } from "../../client.js";
import { deleteQurlTool, deleteQurlSchema } from "../../tools/delete-qurl.js";
import { makeMockClient } from "../helpers.js";

describe("deleteQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = deleteQurlTool(makeMockClient());
      expect(tool.name).toBe("delete_qurl");
    });

    it("has a description mentioning revoke", () => {
      const tool = deleteQurlTool(makeMockClient());
      expect(tool.description.toLowerCase()).toContain("revoke");
    });
  });

  describe("schema", () => {
    it("requires resource_id", () => {
      const result = deleteQurlSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts valid resource_id string", () => {
      const result = deleteQurlSchema.safeParse({ resource_id: "r_abc" });
      expect(result.success).toBe(true);
    });

    it("rejects non-string resource_id", () => {
      const result = deleteQurlSchema.safeParse({ resource_id: 42 });
      expect(result.success).toBe(false);
    });

    it("rejects empty resource_id", () => {
      const result = deleteQurlSchema.safeParse({ resource_id: "" });
      expect(result.success).toBe(false);
    });

    it("rejects q_ prefix IDs (DELETE only accepts r_)", () => {
      const result = deleteQurlSchema.safeParse({ resource_id: "q_abc123456" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("delete_qurl only accepts resource IDs");
      }
    });
  });

  describe("handler", () => {
    it("calls client.deleteQURL with resource_id", async () => {
      const mockDelete = vi.fn().mockResolvedValue(undefined);
      const client = makeMockClient({ deleteQURL: mockDelete });
      const tool = deleteQurlTool(client);

      await tool.handler({ resource_id: "r_abc123" });

      expect(mockDelete).toHaveBeenCalledWith("r_abc123");
    });

    it("returns confirmation message with resource_id", async () => {
      const mockDelete = vi.fn().mockResolvedValue(undefined);
      const client = makeMockClient({ deleteQURL: mockDelete });
      const tool = deleteQurlTool(client);

      const result = await tool.handler({ resource_id: "r_abc123" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("qURL r_abc123 has been revoked.");
    });

    it("propagates client errors", async () => {
      const mockDelete = vi.fn().mockRejectedValue(new Error("Forbidden"));
      const client = makeMockClient({ deleteQURL: mockDelete });
      const tool = deleteQurlTool(client);

      await expect(tool.handler({ resource_id: "r_abc" })).rejects.toThrow("Forbidden");
    });

    it("swallows 404 from a re-delete and returns the same payload", async () => {
      const mockDelete = vi
        .fn()
        .mockRejectedValue(new QURLAPIError(404, "not_found", "Resource not found."));
      const client = makeMockClient({ deleteQURL: mockDelete });
      const tool = deleteQurlTool(client);

      const result = await tool.handler({ resource_id: "r_abc123" });

      expect(result.content[0].text).toBe("qURL r_abc123 has been revoked.");
      expect(result.structuredContent).toEqual({
        resource_id: "r_abc123",
        revoked: true,
        message: "qURL r_abc123 has been revoked.",
      });
    });

    it("propagates non-404 QURLAPIErrors", async () => {
      const mockDelete = vi
        .fn()
        .mockRejectedValue(new QURLAPIError(403, "forbidden", "Insufficient permissions."));
      const client = makeMockClient({ deleteQURL: mockDelete });
      const tool = deleteQurlTool(client);

      await expect(tool.handler({ resource_id: "r_abc" })).rejects.toThrow(
        "Insufficient permissions.",
      );
    });
  });
});
