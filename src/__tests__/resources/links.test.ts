import { describe, it, expect, vi } from "vitest";
import { linksResource } from "../../resources/links.js";
import { makeMockClient, sampleQURL } from "../helpers.js";

const sampleQURLs = [
  sampleQURL({
    resource_id: "r_link1",
    qurl_link: "https://qurl.link/at_1",
    qurl_site: "https://1.qurl.site",
    target_url: "https://example.com/1",
    expires_at: "2026-03-15T00:00:00Z",
  }),
  sampleQURL({
    resource_id: "r_link2",
    qurl_link: "https://qurl.link/at_2",
    qurl_site: "https://2.qurl.site",
    target_url: "https://example.com/2",
    expires_at: "2026-03-20T00:00:00Z",
    access_count: 3,
    one_time_use: true,
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
      expect(resource.name).toBe("Active QURL Links");
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
  });
});
