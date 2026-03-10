import { describe, it, expect, vi } from "vitest";
import { listQurlsTool, listQurlsSchema } from "../../tools/list-qurls.js";
import type { QURLClient, QURL, ListQURLsOutput } from "../../client.js";

function makeMockClient(overrides: Partial<QURLClient> = {}): QURLClient {
  return {
    createQURL: vi.fn(),
    getQURL: vi.fn(),
    listQURLs: vi.fn(),
    deleteQURL: vi.fn(),
    extendQURL: vi.fn(),
    resolveQURL: vi.fn(),
    getQuota: vi.fn(),
    ...overrides,
  } as unknown as QURLClient;
}

const sampleQURL: QURL = {
  resource_id: "r_abc",
  qurl_link: "https://qurl.link/at_abc",
  qurl_site: "https://example.qurl.site",
  target_url: "https://example.com",
  expires_at: "2026-03-10T00:00:00Z",
  created_at: "2026-03-09T00:00:00Z",
  status: "active",
  access_count: 0,
  one_time_use: false,
  max_sessions: 1,
};

describe("listQurlsTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = listQurlsTool(makeMockClient());
      expect(tool.name).toBe("list_qurls");
    });

    it("has a description", () => {
      const tool = listQurlsTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(0);
    });
  });

  describe("schema", () => {
    it("accepts empty input", () => {
      const result = listQurlsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts limit within range", () => {
      const result = listQurlsSchema.safeParse({ limit: 50 });
      expect(result.success).toBe(true);
    });

    it("rejects limit below 1", () => {
      const result = listQurlsSchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects limit above 100", () => {
      const result = listQurlsSchema.safeParse({ limit: 101 });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer limit", () => {
      const result = listQurlsSchema.safeParse({ limit: 10.5 });
      expect(result.success).toBe(false);
    });

    it("accepts cursor string", () => {
      const result = listQurlsSchema.safeParse({ cursor: "cur_xyz" });
      expect(result.success).toBe(true);
    });

    it("accepts limit and cursor together", () => {
      const result = listQurlsSchema.safeParse({ limit: 20, cursor: "cur_abc" });
      expect(result.success).toBe(true);
    });
  });

  describe("handler", () => {
    it("calls client.listQURLs and returns full result as JSON", async () => {
      const listResult: ListQURLsOutput = {
        data: [sampleQURL],
        meta: { has_more: false },
      };
      const mockList = vi.fn().mockResolvedValue(listResult);
      const client = makeMockClient({ listQURLs: mockList });
      const tool = listQurlsTool(client);

      const result = await tool.handler({});

      expect(mockList).toHaveBeenCalledWith({});
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].resource_id).toBe("r_abc");
      expect(parsed.meta.has_more).toBe(false);
    });

    it("returns full result including meta with pagination info", async () => {
      const listResult: ListQURLsOutput = {
        data: [sampleQURL],
        meta: { next_cursor: "cur_next", has_more: true },
      };
      const mockList = vi.fn().mockResolvedValue(listResult);
      const client = makeMockClient({ listQURLs: mockList });
      const tool = listQurlsTool(client);

      const result = await tool.handler({ limit: 1 });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.meta.next_cursor).toBe("cur_next");
      expect(parsed.meta.has_more).toBe(true);
    });

    it("passes limit and cursor to client", async () => {
      const mockList = vi.fn().mockResolvedValue({ data: [], meta: { has_more: false } });
      const client = makeMockClient({ listQURLs: mockList });
      const tool = listQurlsTool(client);

      await tool.handler({ limit: 10, cursor: "cur_abc" });

      expect(mockList).toHaveBeenCalledWith({ limit: 10, cursor: "cur_abc" });
    });

    it("handles empty list result", async () => {
      const mockList = vi.fn().mockResolvedValue({ data: [], meta: { has_more: false } });
      const client = makeMockClient({ listQURLs: mockList });
      const tool = listQurlsTool(client);

      const result = await tool.handler({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.data).toEqual([]);
    });

    it("propagates client errors", async () => {
      const mockList = vi.fn().mockRejectedValue(new Error("Network error"));
      const client = makeMockClient({ listQURLs: mockList });
      const tool = listQurlsTool(client);

      await expect(tool.handler({})).rejects.toThrow("Network error");
    });
  });
});
