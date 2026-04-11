import { describe, it, expect, vi } from "vitest";
import { listQurlsTool, listQurlsSchema } from "../../tools/list-qurls.js";
import type { ListQURLsOutput } from "../../client.js";
import { makeMockClient, sampleQURL } from "../helpers.js";

const fixture = sampleQURL({ resource_id: "r_abc" });

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

    it("accepts filter fields", () => {
      const result = listQurlsSchema.safeParse({
        status: "active",
        created_after: "2026-01-01T00:00:00Z",
        created_before: "2026-12-31T23:59:59Z",
        expires_before: "2026-06-01T00:00:00Z",
        expires_after: "2026-03-01T00:00:00Z",
        sort: "created_at:desc",
        q: "dashboard",
      });
      expect(result.success).toBe(true);
    });

    it("accepts sort without direction", () => {
      const result = listQurlsSchema.safeParse({ sort: "expires_at" });
      expect(result.success).toBe(true);
    });

    it("accepts sort with asc direction", () => {
      const result = listQurlsSchema.safeParse({ sort: "created_at:asc" });
      expect(result.success).toBe(true);
    });

    it("rejects sort with invalid field", () => {
      const result = listQurlsSchema.safeParse({ sort: "name:desc" });
      expect(result.success).toBe(false);
    });

    it("rejects sort with invalid direction", () => {
      const result = listQurlsSchema.safeParse({ sort: "created_at:up" });
      expect(result.success).toBe(false);
    });

    it("rejects sort with malformed separator", () => {
      const result = listQurlsSchema.safeParse({ sort: "created_at desc" });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.listQURLs and returns full result as JSON", async () => {
      const listResult: ListQURLsOutput = {
        data: [fixture],
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
        data: [fixture],
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

    it("forwards all filter params to the client", async () => {
      const mockList = vi.fn().mockResolvedValue({ data: [], meta: { has_more: false } });
      const client = makeMockClient({ listQURLs: mockList });
      const tool = listQurlsTool(client);

      const input = {
        status: "active",
        created_after: "2026-01-01T00:00:00Z",
        created_before: "2026-12-31T23:59:59Z",
        expires_before: "2026-06-01T00:00:00Z",
        expires_after: "2026-03-01T00:00:00Z",
        sort: "created_at:desc",
        q: "dashboard",
      };
      await tool.handler(input);

      expect(mockList).toHaveBeenCalledWith(input);
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
