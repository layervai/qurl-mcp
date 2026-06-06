import { describe, it, expect, vi } from "vitest";
import { revokeQurlTokenTool, revokeQurlTokenSchema } from "../../tools/revoke-qurl-token.js";
import { makeMockClient } from "../helpers.js";

const resourceId = "r_abc123def45";
const qurlId = "q_abc123def45";

describe("revokeQurlTokenTool", () => {
  describe("schema", () => {
    it("requires resource_id and qurl_id", () => {
      expect(revokeQurlTokenSchema.safeParse({}).success).toBe(false);
      expect(revokeQurlTokenSchema.safeParse({ resource_id: resourceId }).success).toBe(false);
      expect(revokeQurlTokenSchema.safeParse({ qurl_id: qurlId }).success).toBe(false);
    });

    it("accepts valid resource and qURL IDs", () => {
      expect(
        revokeQurlTokenSchema.safeParse({ resource_id: resourceId, qurl_id: qurlId }).success,
      ).toBe(true);
    });

    it("rejects swapped ID prefixes", () => {
      expect(
        revokeQurlTokenSchema.safeParse({ resource_id: qurlId, qurl_id: resourceId }).success,
      ).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.revokeQurlToken and returns confirmation", async () => {
      const mockRevoke = vi.fn().mockResolvedValue(undefined);
      const tool = revokeQurlTokenTool(makeMockClient({ revokeQurlToken: mockRevoke }));

      const result = await tool.handler({ resource_id: resourceId, qurl_id: qurlId });

      expect(mockRevoke).toHaveBeenCalledWith(resourceId, qurlId);
      expect(result.structuredContent).toEqual({
        resource_id: resourceId,
        qurl_id: qurlId,
        revoked: true,
        message: `qURL token ${qurlId} is revoked.`,
      });
    });

    it("propagates client errors", async () => {
      const mockRevoke = vi.fn().mockRejectedValue(new Error("not active"));
      const tool = revokeQurlTokenTool(makeMockClient({ revokeQurlToken: mockRevoke }));

      await expect(tool.handler({ resource_id: resourceId, qurl_id: qurlId })).rejects.toThrow(
        "not active",
      );
    });
  });
});
