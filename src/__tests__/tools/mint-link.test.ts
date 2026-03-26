import { describe, it, expect, vi } from "vitest";
import { mintLinkTool, mintLinkSchema } from "../../tools/mint-link.js";
import { makeMockClient } from "../helpers.js";

const fixture = {
  qurl_link: "https://qurl.link/at_newtoken123",
  expires_at: "2026-04-01T00:00:00Z",
};

describe("mintLinkTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = mintLinkTool(makeMockClient());
      expect(tool.name).toBe("mint_link");
    });

    it("has a description", () => {
      const tool = mintLinkTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description).toContain("access link");
    });
  });

  describe("schema", () => {
    it("requires resource_id", () => {
      const result = mintLinkSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts valid resource_id", () => {
      const result = mintLinkSchema.safeParse({ resource_id: "r_abc123" });
      expect(result.success).toBe(true);
    });

    it("accepts optional fields", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: "r_abc123",
        label: "Alice",
        expires_in: "5m",
        one_time_use: true,
        max_sessions: 1,
        session_duration: "30m",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("handler", () => {
    it("calls client.mintLink with resource_id and body", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      await tool.handler({ resource_id: "r_abc123", label: "Alice" });

      expect(mockMint).toHaveBeenCalledWith("r_abc123", { label: "Alice" });
    });

    it("returns mint data as formatted JSON", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      const result = await tool.handler({ resource_id: "r_abc123" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.qurl_link).toBe("https://qurl.link/at_newtoken123");
      expect(parsed.expires_at).toBe("2026-04-01T00:00:00Z");
    });

    it("propagates client errors", async () => {
      const mockMint = vi.fn().mockRejectedValue(new Error("Not found"));
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      await expect(tool.handler({ resource_id: "r_nope" })).rejects.toThrow("Not found");
    });
  });
});
