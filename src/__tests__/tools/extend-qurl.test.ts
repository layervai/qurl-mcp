import { describe, it, expect, vi } from "vitest";
import { extendQurlTool, extendQurlSchema } from "../../tools/extend-qurl.js";
import { makeMockClient, sampleAccessToken, sampleQURL } from "../helpers.js";

const validResourceId = "r_abc123def45";
const extendResourceId = "r_extend12345";

const fixture = sampleQURL({
  resource_id: extendResourceId,
  qurl_site: "https://ext.qurl.site",
  target_url: "https://example.com/extended",
  expires_at: "2026-04-09T00:00:00Z",
  qurl_count: 3,
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
      expect(extendQurlSchema.safeParse({ resource_id: validResourceId }).success).toBe(false);
      expect(extendQurlSchema.safeParse({ extend_by: "24h" }).success).toBe(false);
    });

    it("accepts valid input", () => {
      const result = extendQurlSchema.safeParse({
        resource_id: validResourceId,
        extend_by: "24h",
      });
      expect(result.success).toBe(true);
    });

    it("rejects non-string extend_by", () => {
      const result = extendQurlSchema.safeParse({
        resource_id: validResourceId,
        extend_by: 24,
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty resource_id", () => {
      const result = extendQurlSchema.safeParse({
        resource_id: "",
        extend_by: "24h",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty extend_by", () => {
      const result = extendQurlSchema.safeParse({
        resource_id: validResourceId,
        extend_by: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    const activeLink = sampleAccessToken({ qurl_id: "q_aaaaaaaaaaa", status: "active" });
    const withLinks = (...qurls: ReturnType<typeof sampleAccessToken>[]) =>
      vi.fn().mockResolvedValue({ data: { ...fixture, qurls } });

    // Regression (qurl-mcp#279): extending the resource left the link's own
    // expiry unchanged, so the link still closed on time.
    it("extends the resource's only active link, not the resource", async () => {
      const getQURL = withLinks(
        activeLink,
        sampleAccessToken({ qurl_id: "q_bbbbbbbbbbb", status: "revoked" }),
      );
      const updateQurlToken = vi.fn().mockResolvedValue({ data: activeLink });
      const updateQURL = vi.fn();
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken, updateQURL }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "48h" });

      expect(updateQurlToken).toHaveBeenCalledWith(extendResourceId, "q_aaaaaaaaaaa", {
        extend_by: "48h",
      });
      expect(updateQURL).not.toHaveBeenCalled();
      expect(JSON.parse(result.content[0].text).qurls[0].qurl_id).toBe("q_aaaaaaaaaaa");
    });

    it.each([
      { description: "an explicit qurl_id", input: { qurl_id: "q_ccccccccccc" } },
      { description: "a q_ display ID as resource_id", input: { resource_id: "q_ccccccccccc" } },
    ])("extends the link named by $description", async ({ input }) => {
      const updateQurlToken = vi.fn().mockResolvedValue({ data: activeLink });
      const getQURL = withLinks(activeLink);
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));
      const request = { resource_id: extendResourceId, extend_by: "1h", ...input };

      await tool.handler(request);

      // The token route takes the parent resource, never the q_ display ID.
      expect(updateQurlToken).toHaveBeenCalledWith(extendResourceId, "q_ccccccccccc", {
        extend_by: "1h",
      });
    });

    it.each([
      { description: "no active link", links: [], message: "no active link" },
      {
        description: "several active links",
        links: [activeLink, sampleAccessToken({ qurl_id: "q_ddddddddddd", status: "active" })],
        message: "pass qurl_id",
      },
    ])(
      "asks the caller to choose when the resource has $description",
      async ({ links, message }) => {
        const updateQurlToken = vi.fn();
        const tool = extendQurlTool(
          makeMockClient({ getQURL: withLinks(...links), updateQurlToken }),
        );

        const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

        expect(result).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining(message) }],
        });
        expect(updateQurlToken).not.toHaveBeenCalled();
      },
    );

    it("does not claim the resource has no links when the read omitted them", async () => {
      const updateQurlToken = vi.fn();
      const getQURL = vi.fn().mockResolvedValue({ data: { ...fixture, qurls: undefined } });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(result).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("did not include its links") }],
      });
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("rejects a q_ resource_id and a different qurl_id instead of guessing", async () => {
      const updateQurlToken = vi.fn();
      const tool = extendQurlTool(
        makeMockClient({ getQURL: withLinks(activeLink), updateQurlToken }),
      );

      const result = await tool.handler({
        resource_id: "q_ccccccccccc",
        qurl_id: "q_ddddddddddd",
        extend_by: "1h",
      });

      expect(result).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("pass one link") }],
      });
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("caps the link list in the ambiguity message", async () => {
      const links = Array.from({ length: 12 }, (_, index) =>
        sampleAccessToken({
          qurl_id: `q_${index.toString(16).padStart(11, "0")}`,
          status: "active",
        }),
      );
      const tool = extendQurlTool(makeMockClient({ getQURL: withLinks(...links) }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("12 active links");
      expect(JSON.stringify(result)).toContain("and 2 more");
    });

    it("reports a completed extension without inviting a retry when the resource read fails", async () => {
      const updateQurlToken = vi.fn().mockResolvedValue({
        data: { ...activeLink, expires_at: "2026-09-20T00:00:00Z" },
      });
      const getQURL = vi.fn().mockRejectedValue(new Error("insufficient_scope"));
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({
        resource_id: extendResourceId,
        extend_by: "1h",
        qurl_id: "q_aaaaaaaaaaa",
      });

      expect(updateQurlToken).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("Do not retry") }],
      });
      expect(JSON.stringify(result)).toContain("2026-09-20T00:00:00Z");
    });

    it("propagates client errors", async () => {
      const tool = extendQurlTool(
        makeMockClient({
          getQURL: withLinks(activeLink),
          updateQurlToken: vi.fn().mockRejectedValue(new Error("QURL expired")),
        }),
      );

      await expect(
        tool.handler({ resource_id: "r_expired1234", extend_by: "24h" }),
      ).rejects.toThrow("QURL expired");
    });
  });
});
