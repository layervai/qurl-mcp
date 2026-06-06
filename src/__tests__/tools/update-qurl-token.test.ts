import { describe, it, expect, vi } from "vitest";
import { updateQurlTokenTool, updateQurlTokenSchema } from "../../tools/update-qurl-token.js";
import { makeMockClient, sampleAccessToken } from "../helpers.js";

const resourceId = "r_abc123def45";
const qurlId = "q_abc123def45";
const fixture = sampleAccessToken({ qurl_id: qurlId, label: "Alice", max_sessions: 5 });

describe("updateQurlTokenTool", () => {
  describe("schema", () => {
    it("accepts a token update", () => {
      const result = updateQurlTokenSchema.safeParse({
        resource_id: resourceId,
        qurl_id: qurlId,
        max_sessions: 5,
      });
      expect(result.success).toBe(true);
    });

    it("accepts empty session_duration to apply the parent cap", () => {
      const result = updateQurlTokenSchema.safeParse({
        resource_id: resourceId,
        qurl_id: qurlId,
        session_duration: "",
      });
      expect(result.success).toBe(true);
    });

    it("rejects both extend_by and expires_at", () => {
      const result = updateQurlTokenSchema.safeParse({
        resource_id: resourceId,
        qurl_id: qurlId,
        extend_by: "1h",
        expires_at: "2026-06-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing update fields", () => {
      const result = updateQurlTokenSchema.safeParse({
        resource_id: resourceId,
        qurl_id: qurlId,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.updateQurlToken with path IDs and body", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const tool = updateQurlTokenTool(makeMockClient({ updateQurlToken: mockUpdate }));

      const result = await tool.handler({
        resource_id: resourceId,
        qurl_id: qurlId,
        max_sessions: 5,
      });

      expect(mockUpdate).toHaveBeenCalledWith(resourceId, qurlId, { max_sessions: 5 });
      expect(JSON.parse(result.content[0].text).qurl_id).toBe(qurlId);
      expect(result.structuredContent).toEqual(fixture);
    });

    it("returns isError when refinements fail", async () => {
      const mockUpdate = vi.fn();
      const tool = updateQurlTokenTool(makeMockClient({ updateQurlToken: mockUpdate }));

      const result = await tool.handler({ resource_id: resourceId, qurl_id: qurlId });

      expect(result.isError).toBe(true);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
