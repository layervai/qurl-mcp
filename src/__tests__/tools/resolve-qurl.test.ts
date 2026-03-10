import { describe, it, expect, vi } from "vitest";
import { resolveQurlTool, resolveQurlSchema } from "../../tools/resolve-qurl.js";
import type { ResolveOutput } from "../../client.js";
import { makeMockClient } from "../helpers.js";

const sampleResolveOutput: ResolveOutput = {
  target_url: "https://example.com/secret",
  resource_id: "r_resolved1",
  session_id: "s_session1",
  access_grant: {
    expires_in: 300,
    granted_at: "2026-03-09T12:00:00Z",
    src_ip: "192.168.1.100",
  },
};

describe("resolveQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = resolveQurlTool(makeMockClient());
      expect(tool.name).toBe("resolve_qurl");
    });

    it("has a description mentioning resolve and firewall", () => {
      const tool = resolveQurlTool(makeMockClient());
      expect(tool.description).toContain("Resolve");
      expect(tool.description).toContain("firewall");
    });
  });

  describe("schema", () => {
    it("requires access_token", () => {
      const result = resolveQurlSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts valid access_token", () => {
      const result = resolveQurlSchema.safeParse({
        access_token: "at_k8xqp9h2sj9lx7r4a",
      });
      expect(result.success).toBe(true);
    });

    it("rejects non-string access_token", () => {
      const result = resolveQurlSchema.safeParse({ access_token: 12345 });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.resolveQURL with the input", async () => {
      const mockResolve = vi.fn().mockResolvedValue({ data: sampleResolveOutput });
      const client = makeMockClient({ resolveQURL: mockResolve });
      const tool = resolveQurlTool(client);

      await tool.handler({ access_token: "at_token123" });

      expect(mockResolve).toHaveBeenCalledWith({ access_token: "at_token123" });
    });

    it("returns resolve data as formatted JSON", async () => {
      const mockResolve = vi.fn().mockResolvedValue({ data: sampleResolveOutput });
      const client = makeMockClient({ resolveQURL: mockResolve });
      const tool = resolveQurlTool(client);

      const result = await tool.handler({ access_token: "at_token123" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.target_url).toBe("https://example.com/secret");
      expect(parsed.resource_id).toBe("r_resolved1");
      expect(parsed.session_id).toBe("s_session1");
      expect(parsed.access_grant.expires_in).toBe(300);
      expect(parsed.access_grant.src_ip).toBe("192.168.1.100");
    });

    it("returns only the data object, not the wrapper", async () => {
      const mockResolve = vi.fn().mockResolvedValue({ data: sampleResolveOutput });
      const client = makeMockClient({ resolveQURL: mockResolve });
      const tool = resolveQurlTool(client);

      const result = await tool.handler({ access_token: "at_token123" });
      expect(result.content[0].text).toBe(JSON.stringify(sampleResolveOutput, null, 2));
    });

    it("propagates client errors", async () => {
      const mockResolve = vi.fn().mockRejectedValue(new Error("Token expired"));
      const client = makeMockClient({ resolveQURL: mockResolve });
      const tool = resolveQurlTool(client);

      await expect(tool.handler({ access_token: "at_expired" })).rejects.toThrow(
        "Token expired",
      );
    });
  });
});
