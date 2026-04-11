import { describe, it, expect, vi } from "vitest";
import { mintLinkTool, mintLinkBaseSchema, mintLinkSchema } from "../../tools/mint-link.js";
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
      const result = mintLinkBaseSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts valid resource_id", () => {
      const result = mintLinkSchema.safeParse({ resource_id: "r_abc123" });
      expect(result.success).toBe(true);
    });

    it("accepts expires_in", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: "r_abc123",
        expires_in: "7d",
      });
      expect(result.success).toBe(true);
    });

    it("accepts expires_at", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: "r_abc123",
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(true);
    });

    it("rejects both expires_in and expires_at", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: "r_abc123",
        expires_in: "7d",
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
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

    it("accepts access_policy", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: "r_abc123",
        access_policy: {
          geo_allowlist: ["US", "CA"],
          ip_denylist: ["10.0.0.0/8"],
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects max_sessions above 1000 (API hard limit)", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: "r_abc123",
        max_sessions: 1001,
      });
      expect(result.success).toBe(false);
    });

    it("rejects label longer than 500 characters", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: "r_abc123",
        label: "x".repeat(501),
      });
      expect(result.success).toBe(false);
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

    it("passes undefined body when only resource_id is provided", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      await tool.handler({ resource_id: "r_abc123" });

      expect(mockMint).toHaveBeenCalledWith("r_abc123", undefined);
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

    it("returns isError response when both expires_in and expires_at are provided", async () => {
      const mockMint = vi.fn();
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      const result = await tool.handler({
        resource_id: "r_abc123",
        expires_in: "7d",
        expires_at: "2026-04-01T00:00:00Z",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("expires_in or expires_at");
      expect(mockMint).not.toHaveBeenCalled();
    });
  });
});
