import { describe, it, expect, vi } from "vitest";
import { updateQurlTool, updateQurlSchema } from "../../tools/update-qurl.js";
import { makeMockClient, sampleQURL } from "../helpers.js";

const validResourceId = "r_abc123def45";
const updateResourceId = "r_update12345";

const fixture = sampleQURL({
  resource_id: updateResourceId,
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

    it("rejects empty resource_id", () => {
      const result = updateQurlSchema.safeParse({ resource_id: "", extend_by: "24h" });
      expect(result.success).toBe(false);
    });

    it("accepts resource_id with extend_by", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        extend_by: "24h",
      });
      expect(result.success).toBe(true);
    });

    it("accepts resource_id with expires_at", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(true);
    });

    it("accepts RFC 3339 timezone offsets", () => {
      expect(
        updateQurlSchema.safeParse({
          resource_id: validResourceId,
          expires_at: "2026-04-01T02:00:00+02:00",
        }).success,
      ).toBe(true);
    });

    it("accepts tags and description", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        tags: ["prod", "api"],
        description: "Updated description",
      });
      expect(result.success).toBe(true);
    });

    it("rejects more than 10 tags", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
      });
      expect(result.success).toBe(false);
    });

    it("rejects tags longer than 50 characters", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        tags: ["x".repeat(51)],
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty tag strings", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        tags: [""],
      });
      expect(result.success).toBe(false);
    });

    it("rejects tags that don't match the API pattern", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        tags: ["-invalid"], // must start with alphanumeric
      });
      expect(result.success).toBe(false);
    });

    it("rejects description longer than 500 characters", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        description: "x".repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it("accepts description: '' to clear the field (API clear semantics)", () => {
      // The API documents `description: ""` as the way to clear the field.
      // See qurl/api/openapi.yaml -> UpdateQurlRequest.description.
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        description: "",
      });
      expect(result.success).toBe(true);
    });

    it("accepts tags: [] to clear all tags (API clear semantics)", () => {
      // The API documents `tags: []` as the way to clear all tags.
      // See qurl/api/openapi.yaml -> UpdateQurlRequest.tags.
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        tags: [],
      });
      expect(result.success).toBe(true);
    });

    it("accepts custom_domain", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        custom_domain: "app.example.com",
      });
      expect(result.success).toBe(true);
    });

    it('accepts custom_domain: "" to clear the field', () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        custom_domain: "",
      });
      expect(result.success).toBe(true);
    });

    it("rejects custom_domain longer than 253 characters", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        custom_domain: "a".repeat(254),
      });
      expect(result.success).toBe(false);
    });

    it("accepts preserve_host: true / false", () => {
      expect(
        updateQurlSchema.safeParse({ resource_id: validResourceId, preserve_host: true }).success,
      ).toBe(true);
      expect(
        updateQurlSchema.safeParse({ resource_id: validResourceId, preserve_host: false }).success,
      ).toBe(true);
    });

    it("rejects non-boolean preserve_host", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        preserve_host: "yes",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string extend_by", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
        extend_by: 24,
      });
      expect(result.success).toBe(false);
    });

    it("rejects both extend_by and expires_at", () => {
      const result = updateQurlSchema.safeParse({
        resource_id: validResourceId,
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
        resource_id: validResourceId,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) =>
              i.message ===
              "At least one update field (extend_by, expires_at, tags, description, custom_domain, or preserve_host) is required",
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

      await tool.handler({ resource_id: updateResourceId, extend_by: "48h" });

      expect(mockUpdate).toHaveBeenCalledWith(updateResourceId, { extend_by: "48h" });
    });

    it("returns updated qURL data as formatted JSON", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      const result = await tool.handler({ resource_id: updateResourceId, extend_by: "48h" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe(updateResourceId);
      expect(parsed.expires_at).toBe("2026-04-09T00:00:00Z");
    });

    it("returns only the data object, not the wrapper", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      const result = await tool.handler({ resource_id: updateResourceId, extend_by: "24h" });
      expect(result.content[0].text).toBe(JSON.stringify(fixture));
    });

    it("passes tags and description to client", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      await tool.handler({
        resource_id: updateResourceId,
        tags: ["prod", "api"],
        description: "New desc",
      });

      expect(mockUpdate).toHaveBeenCalledWith(updateResourceId, {
        tags: ["prod", "api"],
        description: "New desc",
      });
    });

    it("passes custom_domain and preserve_host to client", async () => {
      const mockUpdateQurl = vi.fn();
      const mockUpdateResource = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({
        updateQURL: mockUpdateQurl,
        updateResource: mockUpdateResource,
      });
      const tool = updateQurlTool(client);

      await tool.handler({
        resource_id: updateResourceId,
        custom_domain: "app.example.com",
        preserve_host: true,
      });

      expect(mockUpdateQurl).not.toHaveBeenCalled();
      expect(mockUpdateResource).toHaveBeenCalledWith(updateResourceId, {
        custom_domain: "app.example.com",
        preserve_host: true,
      });
    });

    it("passes the clear-custom_domain + preserve_host combo through verbatim", async () => {
      const mockUpdateResource = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ updateResource: mockUpdateResource });
      const tool = updateQurlTool(client);

      await tool.handler({
        resource_id: updateResourceId,
        custom_domain: "",
        preserve_host: false,
      });

      expect(mockUpdateResource).toHaveBeenCalledWith(updateResourceId, {
        custom_domain: "",
        preserve_host: false,
      });
    });

    it("routes tags and description with custom_domain through the resource endpoint", async () => {
      const mockUpdateQurl = vi.fn();
      const mockUpdateResource = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({
        updateQURL: mockUpdateQurl,
        updateResource: mockUpdateResource,
      });
      const tool = updateQurlTool(client);

      await tool.handler({
        resource_id: updateResourceId,
        tags: ["prod"],
        description: "New desc",
        custom_domain: "app.example.com",
      });

      expect(mockUpdateQurl).not.toHaveBeenCalled();
      expect(mockUpdateResource).toHaveBeenCalledWith(updateResourceId, {
        tags: ["prod"],
        description: "New desc",
        custom_domain: "app.example.com",
      });
    });

    it("rejects custom_domain when called with a q_ display ID", async () => {
      const mockUpdateQurl = vi.fn();
      const mockUpdateResource = vi.fn();
      const client = makeMockClient({
        updateQURL: mockUpdateQurl,
        updateResource: mockUpdateResource,
      });
      const tool = updateQurlTool(client);

      const result = await tool.handler({
        resource_id: "q_abc123def45",
        custom_domain: "app.example.com",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("require an r_ resource ID");
      expect(mockUpdateQurl).not.toHaveBeenCalled();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    it("rejects combining expiration changes with resource-endpoint updates", async () => {
      const mockUpdateQurl = vi.fn();
      const mockUpdateResource = vi.fn();
      const client = makeMockClient({
        updateQURL: mockUpdateQurl,
        updateResource: mockUpdateResource,
      });
      const tool = updateQurlTool(client);

      const result = await tool.handler({
        resource_id: updateResourceId,
        extend_by: "24h",
        custom_domain: "app.example.com",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("cannot be combined with extend_by or expires_at");
      expect(mockUpdateQurl).not.toHaveBeenCalled();
      expect(mockUpdateResource).not.toHaveBeenCalled();
    });

    it("propagates client errors", async () => {
      const mockUpdate = vi.fn().mockRejectedValue(new Error("QURL expired"));
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      await expect(
        tool.handler({ resource_id: "r_expired1234", extend_by: "24h" }),
      ).rejects.toThrow("QURL expired");
    });

    it("returns isError response when both extend_by and expires_at are provided", async () => {
      const mockUpdate = vi.fn();
      const client = makeMockClient({ updateQURL: mockUpdate });
      const tool = updateQurlTool(client);

      const result = await tool.handler({
        resource_id: validResourceId,
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

      const result = await tool.handler({ resource_id: validResourceId });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("At least one update field");
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
