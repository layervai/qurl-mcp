import { describe, it, expect, vi } from "vitest";
import { QURLAPIError } from "../../client.js";
import { extendQurlTool, extendQurlSchema } from "../../tools/extend-qurl.js";
import { makeMockClient, sampleAccessToken, sampleQURL } from "../helpers.js";

const validResourceId = "r_abc123def45";
const extendResourceId = "r_extend12345";

const fixture = sampleQURL({
  resource_id: extendResourceId,
  qurl_site: "https://ext.qurl.site",
  target_url: "https://example.com/extended",
  expires_at: "2026-04-09T00:00:00Z",
  // Unknown by default, so a short link list reads as complete (under the cap).
  qurl_count: undefined,
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
      vi.fn().mockResolvedValue({ data: { ...fixture, qurls, qurl_count: qurls.length } });

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
      const getQURL = withLinks(
        activeLink,
        sampleAccessToken({ qurl_id: "q_ccccccccccc", status: "active" }),
      );
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));
      const request = { resource_id: extendResourceId, extend_by: "1h", ...input };

      await tool.handler(request);

      // The token route takes the parent resource, never the q_ display ID.
      expect(updateQurlToken).toHaveBeenCalledWith(extendResourceId, "q_ccccccccccc", {
        extend_by: "1h",
      });
      // One read either way: to pick the link, or (fast path) to build the response.
      expect(getQURL).toHaveBeenCalledOnce();
    });

    it("merges a sparse update response into the link it read", async () => {
      const updateQurlToken = vi.fn().mockResolvedValue({
        data: { qurl_id: activeLink.qurl_id, expires_at: "2099-01-01T00:00:00Z" },
      });
      const tool = extendQurlTool(
        makeMockClient({ getQURL: withLinks(activeLink), updateQurlToken }),
      );

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(result.structuredContent).toMatchObject({
        qurls: [{ ...activeLink, expires_at: "2099-01-01T00:00:00Z" }],
      });
    });

    it("splices the updated link into the resource it already read", async () => {
      const extended = { ...activeLink, expires_at: "2099-01-01T00:00:00Z" };
      const updateQurlToken = vi.fn().mockResolvedValue({ data: extended });
      const other = sampleAccessToken({ qurl_id: "q_eeeeeeeeeee", status: "consumed" });
      const getQURL = withLinks(activeLink, other);
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(getQURL).toHaveBeenCalledOnce();
      expect(result.structuredContent).toMatchObject({
        qurls: [extended, other],
        // The changed expiry is named at the top level, apart from the resource's.
        extended_qurl_id: extended.qurl_id,
        extended_link_expires_at: "2099-01-01T00:00:00Z",
      });
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });

    it.each([
      { description: "no links", links: [], message: "no link to extend" },
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

    it("explains a not-found or forbidden pre-update read instead of throwing it raw", async () => {
      const updateQurlToken = vi.fn();
      const getQURL = vi
        .fn()
        .mockRejectedValue(new QURLAPIError(403, "forbidden", "insufficient_scope"));
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("may lack qurl:read");
      expect(result).toMatchObject({ isError: true });
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("lets a rate-limited pre-update read throw with its status", async () => {
      const getQURL = vi.fn().mockRejectedValue(new QURLAPIError(429, "rate_limited", "slow down"));
      const tool = extendQurlTool(makeMockClient({ getQURL }));

      await expect(
        tool.handler({ resource_id: extendResourceId, extend_by: "1h" }),
      ).rejects.toMatchObject({ statusCode: 429, code: "rate_limited" });
    });

    it("does not blame scopes for a non-API failure", async () => {
      const getQURL = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const tool = extendQurlTool(makeMockClient({ getQURL }));

      await expect(
        tool.handler({ resource_id: extendResourceId, extend_by: "1h" }),
      ).rejects.toThrow("fetch failed");
    });

    it("takes the read path when a q_ resource_id and the same qurl_id are both given", async () => {
      const updateQurlToken = vi.fn().mockResolvedValue({ data: activeLink });
      const getQURL = withLinks(sampleAccessToken({ qurl_id: "q_ccccccccccc", status: "active" }));
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      await tool.handler({
        resource_id: "q_ccccccccccc",
        qurl_id: "q_ccccccccccc",
        extend_by: "1h",
      });

      expect(getQURL).toHaveBeenCalledWith("q_ccccccccccc");
      expect(updateQurlToken).toHaveBeenCalledWith(extendResourceId, "q_ccccccccccc", {
        extend_by: "1h",
      });
    });

    it("reads before updating even when qurl_id is named, so a missing qurl:read changes nothing", async () => {
      const getQURL = vi
        .fn()
        .mockRejectedValue(new QURLAPIError(403, "insufficient_scope", "missing qurl:read"));
      const updateQurlToken = vi.fn();
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({
        resource_id: extendResourceId,
        qurl_id: "q_ccccccccccc",
        extend_by: "1h",
      });

      expect(JSON.stringify(result)).toContain("Nothing was extended");
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("past the 100-link preview cap, updates a named link the read did not list and refuses to auto-select", async () => {
      const capped = { ...fixture, qurl_count: 150, qurls: [activeLink] };
      const updateQurlToken = vi.fn().mockResolvedValue({ data: activeLink });
      const getQURL = vi.fn().mockResolvedValue({ data: capped });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      await tool.handler({
        resource_id: extendResourceId,
        qurl_id: "q_fffffffffff",
        extend_by: "1h",
      });
      expect(updateQurlToken).toHaveBeenCalledWith(extendResourceId, "q_fffffffffff", {
        extend_by: "1h",
      });
      // Nothing to splice into, so the response is a reread.
      expect(getQURL).toHaveBeenCalledTimes(2);

      updateQurlToken.mockClear();
      const guessed = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });
      expect(JSON.stringify(guessed)).toContain("pass qurl_id to choose");
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("never trusts a list at the preview cap as complete, whatever qurl_count says", async () => {
      const hundred = Array.from({ length: 100 }, (_, i) =>
        sampleAccessToken({
          qurl_id: `q_${i.toString(16).padStart(11, "0")}`,
          status: i === 0 ? "active" : "revoked",
        }),
      );
      const updateQurlToken = vi.fn();
      const getQURL = vi.fn().mockResolvedValue({
        data: { ...fixture, qurl_count: 40, qurls: hundred },
      });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("pass qurl_id to choose");
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("says a resource with no links has none to extend, even when the read omits the list", async () => {
      const getQURL = vi
        .fn()
        .mockResolvedValue({ data: { ...fixture, qurls: undefined, qurl_count: 0 } });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken: vi.fn() }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("no link to extend");
    });

    it("does not claim a resource has no links when an empty read carries no count", async () => {
      const getQURL = vi
        .fn()
        .mockResolvedValue({ data: { ...fixture, qurls: [], qurl_count: undefined } });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken: vi.fn() }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("The resource read lists no links");
    });

    it("refuses a named qurl_id that the read shows is revoked", async () => {
      const revoked = sampleAccessToken({ qurl_id: "q_ccccccccccc", status: "revoked" });
      const updateQurlToken = vi.fn();
      const tool = extendQurlTool(makeMockClient({ getQURL: withLinks(revoked), updateQurlToken }));

      const result = await tool.handler({
        resource_id: extendResourceId,
        qurl_id: "q_ccccccccccc",
        extend_by: "1h",
      });

      expect(JSON.stringify(result)).toContain("is revoked");
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("reports a q_ link that the resource read does not list", async () => {
      const updateQurlToken = vi.fn();
      const tool = extendQurlTool(
        makeMockClient({ getQURL: withLinks(activeLink), updateQurlToken }),
      );

      const result = await tool.handler({ resource_id: "q_fffffffffff", extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("is not listed on resource");
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("refuses a q_ link that is no longer active", async () => {
      const updateQurlToken = vi.fn();
      const getQURL = withLinks(sampleAccessToken({ qurl_id: "q_eeeeeeeeeee", status: "revoked" }));
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: "q_eeeeeeeeeee", extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("is revoked");
      expect(updateQurlToken).not.toHaveBeenCalled();
    });

    it("rejects an extend_by the duration grammar does not accept", () => {
      for (const extend_by of ["3 hours", "0s"]) {
        expect(
          extendQurlSchema.safeParse({ resource_id: validResourceId, extend_by }).success,
        ).toBe(false);
      }
    });

    it("falls through to the named q_ link when the read omits the link list", async () => {
      const updateQurlToken = vi.fn().mockResolvedValue({ data: activeLink });
      const getQURL = vi.fn().mockResolvedValue({ data: { ...fixture, qurls: undefined } });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: "q_ccccccccccc", extend_by: "1h" });

      expect(updateQurlToken).toHaveBeenCalledWith(extendResourceId, "q_ccccccccccc", {
        extend_by: "1h",
      });
      // No link list to splice into, so the response is the server's reread,
      // never a synthesized one-link list.
      expect(getQURL).toHaveBeenCalledTimes(2);
      expect((result.structuredContent as { qurls?: unknown }).qurls).toBeUndefined();
    });

    it("extends a named q_ link whose status is unrecognized, like auto-selection", async () => {
      const pending = { ...sampleAccessToken({ qurl_id: "q_ccccccccccc" }), status: "pending" };
      const updateQurlToken = vi.fn().mockResolvedValue({ data: activeLink });
      const tool = extendQurlTool(
        makeMockClient({ getQURL: withLinks(pending as never), updateQurlToken }),
      );

      await tool.handler({ resource_id: "q_ccccccccccc", extend_by: "1h" });

      expect(updateQurlToken).toHaveBeenCalledOnce();
    });

    it("warns when the resource's own expiry cuts the extended link short", async () => {
      const getQURL = vi.fn().mockResolvedValue({
        data: { ...fixture, expires_at: "2026-04-09T00:00:00Z", qurls: [activeLink] },
      });
      const updateQurlToken = vi.fn().mockResolvedValue({
        data: { ...activeLink, expires_at: "2026-05-01T00:00:00Z" },
      });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "30d" });

      expect(JSON.parse(result.content[0].text).extend_warning).toContain("update_qurl");
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });

    it("warns when the API clamps the extended link to the resource's expiry", async () => {
      const getQURL = vi.fn().mockResolvedValue({
        data: { ...fixture, expires_at: "2026-04-09T00:00:00Z", qurls: [activeLink] },
      });
      const updateQurlToken = vi.fn().mockResolvedValue({
        data: { ...activeLink, expires_at: "2026-04-09T00:00:00Z" },
      });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "30d" });

      expect(JSON.parse(result.content[0].text).extend_warning).toContain("stops working then");
    });

    it("does not warn when the updated link carries no expiry", async () => {
      const getQURL = vi.fn().mockResolvedValue({
        data: { ...fixture, expires_at: "2026-04-09T00:00:00Z", qurls: [activeLink] },
      });
      const updateQurlToken = vi.fn().mockResolvedValue({
        data: { ...activeLink, expires_at: undefined },
      });
      const tool = extendQurlTool(makeMockClient({ getQURL, updateQurlToken }));

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(JSON.parse(result.content[0].text).extend_warning).toBeUndefined();
    });

    it("treats a link without a status as a candidate", async () => {
      const unlabeled = { ...sampleAccessToken({ qurl_id: "q_aaaaaaaaaaa" }), status: undefined };
      const updateQurlToken = vi.fn().mockResolvedValue({ data: activeLink });
      const tool = extendQurlTool(
        makeMockClient({ getQURL: withLinks(unlabeled as never), updateQurlToken }),
      );

      await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(updateQurlToken).toHaveBeenCalledWith(extendResourceId, "q_aaaaaaaaaaa", {
        extend_by: "1h",
      });
    });

    it("only suggests minting when every listed link is known to be inactive", async () => {
      const tool = extendQurlTool(
        makeMockClient({
          getQURL: withLinks(sampleAccessToken({ qurl_id: "q_aaaaaaaaaaa", status: "revoked" })),
        }),
      );

      const result = await tool.handler({ resource_id: extendResourceId, extend_by: "1h" });

      expect(JSON.stringify(result)).toContain("consumed, expired, or revoked");
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
      // Only a first read without the link list is repeated after the update.
      const getQURL = vi
        .fn()
        .mockResolvedValueOnce({ data: { ...fixture, qurls: undefined } })
        .mockRejectedValue(new Error("upstream blip"));
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
