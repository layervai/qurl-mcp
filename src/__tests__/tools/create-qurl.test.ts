import { describe, it, expect, vi } from "vitest";
import { createQurlTool, createQurlSchema } from "../../tools/create-qurl.js";
import { makeMockClient, sampleCreateQURLData } from "../helpers.js";

const fixture = sampleCreateQURLData();

describe("createQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = createQurlTool(makeMockClient());
      expect(tool.name).toBe("create_qurl");
    });

    it("has a description", () => {
      const tool = createQurlTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description).toContain("QURL");
    });
  });

  describe("schema", () => {
    it("requires target_url", () => {
      const result = createQurlSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("validates target_url is a valid URL", () => {
      const result = createQurlSchema.safeParse({ target_url: "not-a-url" });
      expect(result.success).toBe(false);
    });

    it("accepts valid minimal input", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all optional fields", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        label: "Alice from Acme",
        expires_in: "24h",
        one_time_use: true,
        max_sessions: 5,
        session_duration: "1h",
        custom_domain: "app.example.com",
        access_policy: {
          ip_allowlist: ["192.168.1.0/24"],
          geo_allowlist: ["US"],
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts access_policy with ai_agent_policy", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        access_policy: {
          ai_agent_policy: {
            deny_categories: ["gptbot", "commoncrawl"],
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects non-integer max_sessions", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: 2.5,
      });
      expect(result.success).toBe(false);
    });

    it("accepts max_sessions of 0 (unlimited)", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: 0,
      });
      expect(result.success).toBe(true);
    });

    it("rejects negative max_sessions", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: -1,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.createQURL with input and returns formatted content", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const input = {
        target_url: "https://example.com/protected",
        label: "Test QURL",
      };
      const result = await tool.handler(input);

      expect(mockCreate).toHaveBeenCalledWith(input);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe("r_test123");
      expect(parsed.qurl_link).toBe("https://qurl.link/at_abc123def456ghi789");
      expect(parsed.qurl_id).toBe("q_3a7f2c8e91b");
    });

    it("formats response as compact JSON", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const result = await tool.handler({ target_url: "https://example.com" });

      expect(result.content[0].text).toBe(JSON.stringify(fixture));
    });

    it("propagates client errors", async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error("API Error"));
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      await expect(tool.handler({ target_url: "https://example.com" })).rejects.toThrow(
        "API Error",
      );
    });

    it("passes all optional fields to the client", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const input = {
        target_url: "https://example.com",
        label: "Test",
        expires_in: "1h",
        one_time_use: true,
        max_sessions: 3,
        session_duration: "30m",
        custom_domain: "app.example.com",
      };
      await tool.handler(input);

      expect(mockCreate).toHaveBeenCalledWith(input);
    });
  });
});
