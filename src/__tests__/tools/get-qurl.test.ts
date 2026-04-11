import { describe, it, expect, vi } from "vitest";
import { getQurlTool, getQurlSchema } from "../../tools/get-qurl.js";
import { makeMockClient, sampleQURL } from "../helpers.js";

const fixture = sampleQURL({
  resource_id: "r_test456",
  qurl_site: "https://test.qurl.site",
  target_url: "https://example.com/page",
  description: "A test link",
  expires_at: "2026-03-15T00:00:00Z",
  tags: ["test"],
  qurl_count: 2,
});

describe("getQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = getQurlTool(makeMockClient());
      expect(tool.name).toBe("get_qurl");
    });

    it("has a description mentioning resource ID", () => {
      const tool = getQurlTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description).toContain("resource ID");
    });
  });

  describe("schema", () => {
    it("requires resource_id", () => {
      const result = getQurlSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts valid resource_id string", () => {
      const result = getQurlSchema.safeParse({ resource_id: "r_abc123" });
      expect(result.success).toBe(true);
    });

    it("rejects non-string resource_id", () => {
      const result = getQurlSchema.safeParse({ resource_id: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.getQURL with resource_id and returns data", async () => {
      const mockGet = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ getQURL: mockGet });
      const tool = getQurlTool(client);

      const result = await tool.handler({ resource_id: "r_test456" });

      expect(mockGet).toHaveBeenCalledWith("r_test456");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe("r_test456");
      expect(parsed.target_url).toBe("https://example.com/page");
      expect(parsed.tags).toEqual(["test"]);
      expect(parsed.qurl_count).toBe(2);
      expect(parsed.qurl_link).toBeUndefined();
    });

    it("returns only the data object, not the wrapper", async () => {
      const mockGet = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ getQURL: mockGet });
      const tool = getQurlTool(client);

      const result = await tool.handler({ resource_id: "r_test456" });
      const text = result.content[0].text;

      // Should be the QURL object directly, not { data: ... }
      expect(text).toBe(JSON.stringify(fixture));
    });

    it("passes through qurls array with access token details", async () => {
      const fixtureWithTokens = sampleQURL({
        resource_id: "r_tokens",
        qurl_count: 2,
        qurls: [
          {
            qurl_id: "q_aaa11111111",
            status: "active",
            one_time_use: false,
            max_sessions: 3,
            session_duration: 3600,
            use_count: 1,
            created_at: "2026-03-09T00:00:00Z",
            expires_at: "2026-03-10T00:00:00Z",
          },
          {
            qurl_id: "q_bbb22222222",
            status: "consumed",
            one_time_use: true,
            max_sessions: 1,
            session_duration: 300,
            use_count: 1,
            created_at: "2026-03-09T00:00:00Z",
            expires_at: "2026-03-10T00:00:00Z",
          },
        ],
      });

      const mockGet = vi.fn().mockResolvedValue({ data: fixtureWithTokens });
      const client = makeMockClient({ getQURL: mockGet });
      const tool = getQurlTool(client);

      const result = await tool.handler({ resource_id: "r_tokens" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.qurl_count).toBe(2);
      expect(parsed.qurls).toHaveLength(2);
      expect(parsed.qurls[0].qurl_id).toBe("q_aaa11111111");
      expect(parsed.qurls[0].one_time_use).toBe(false);
      expect(parsed.qurls[0].max_sessions).toBe(3);
      expect(parsed.qurls[1].status).toBe("consumed");
      expect(parsed.qurls[1].one_time_use).toBe(true);
    });

    it("propagates client errors", async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error("Not found"));
      const client = makeMockClient({ getQURL: mockGet });
      const tool = getQurlTool(client);

      await expect(tool.handler({ resource_id: "r_nope" })).rejects.toThrow("Not found");
    });
  });
});
