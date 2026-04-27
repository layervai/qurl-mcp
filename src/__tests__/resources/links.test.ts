import { describe, it, expect, vi } from "vitest";
import { QURLAPIError } from "../../client.js";
import { linksResource } from "../../resources/links.js";
import { makeMockClient, sampleQURL } from "../helpers.js";

const sampleQURLs = [
  sampleQURL({
    resource_id: "r_link1",
    qurl_site: "https://1.qurl.site",
    target_url: "https://example.com/1",
    expires_at: "2026-03-15T00:00:00Z",
  }),
  sampleQURL({
    resource_id: "r_link2",
    qurl_site: "https://2.qurl.site",
    target_url: "https://example.com/2",
    expires_at: "2026-03-20T00:00:00Z",
    tags: ["prod"],
    qurl_count: 3,
  }),
];

describe("linksResource", () => {
  describe("metadata", () => {
    it("has correct URI", () => {
      const resource = linksResource(makeMockClient());
      expect(resource.uri).toBe("qurl://links");
    });

    it("has a name", () => {
      const resource = linksResource(makeMockClient());
      expect(resource.name).toBe("Active qURL Links");
    });

    it("has correct mimeType", () => {
      const resource = linksResource(makeMockClient());
      expect(resource.mimeType).toBe("application/json");
    });

    it("has a description", () => {
      const resource = linksResource(makeMockClient());
      expect(resource.description).toBeTruthy();
    });
  });

  describe("handler", () => {
    it("calls client.listQURLs with limit 50", async () => {
      const mockList = vi
        .fn()
        .mockResolvedValue({ data: sampleQURLs, meta: { has_more: false } });
      const client = makeMockClient({ listQURLs: mockList });
      const resource = linksResource(client);

      await resource.handler();

      expect(mockList).toHaveBeenCalledWith({ limit: 50 });
    });

    it("returns contents array with URI and mimeType", async () => {
      const mockList = vi
        .fn()
        .mockResolvedValue({ data: sampleQURLs, meta: { has_more: false } });
      const client = makeMockClient({ listQURLs: mockList });
      const resource = linksResource(client);

      const result = await resource.handler();

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("qurl://links");
      expect(result.contents[0].mimeType).toBe("application/json");
    });

    it("returns the data array as JSON text", async () => {
      const mockList = vi
        .fn()
        .mockResolvedValue({ data: sampleQURLs, meta: { has_more: false } });
      const client = makeMockClient({ listQURLs: mockList });
      const resource = linksResource(client);

      const result = await resource.handler();
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed).toEqual(sampleQURLs);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].resource_id).toBe("r_link1");
      expect(parsed[1].resource_id).toBe("r_link2");
    });

    it("returns empty array when no links exist", async () => {
      const mockList = vi.fn().mockResolvedValue({ data: [], meta: { has_more: false } });
      const client = makeMockClient({ listQURLs: mockList });
      const resource = linksResource(client);

      const result = await resource.handler();
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed).toEqual([]);
    });

    it("propagates client errors", async () => {
      const mockList = vi.fn().mockRejectedValue(new Error("Auth failed"));
      const client = makeMockClient({ listQURLs: mockList });
      const resource = linksResource(client);

      await expect(resource.handler()).rejects.toThrow("Auth failed");
    });

    it("translates missing_api_key into a content block with error JSON instead of throwing", async () => {
      // Smoke test asserting the withMissingApiKeyResource wrapping is in
      // place. The wrapper itself is unit-tested in resources/_shared.test.ts;
      // this asserts the resource-level UX matches the tool-level UX so a
      // future refactor that drops the wrapper from one resource fails CI.
      const mockList = vi
        .fn()
        .mockRejectedValue(new QURLAPIError(0, "missing_api_key", "QURL_API_KEY is not set."));
      const client = makeMockClient({ listQURLs: mockList });
      const resource = linksResource(client);

      const result = await resource.handler();

      expect(result.contents).toHaveLength(1);
      expect(JSON.parse(result.contents[0].text)).toEqual({
        error: { code: "missing_api_key", message: "QURL_API_KEY is not set." },
      });
    });
  });
});
