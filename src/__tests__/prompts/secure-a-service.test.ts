import { describe, it, expect } from "vitest";
import { secureAServicePrompt } from "../../prompts/secure-a-service.js";

describe("secureAServicePrompt", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const prompt = secureAServicePrompt();
      expect(prompt.name).toBe("secure-a-service");
    });

    it("has a description", () => {
      const prompt = secureAServicePrompt();
      expect(prompt.description).toBeTruthy();
    });

    it("defines args schema with target_url", () => {
      const prompt = secureAServicePrompt();
      expect(prompt.args.target_url).toBeDefined();
    });
  });

  describe("handler", () => {
    it("returns a single user message", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com" });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("includes target_url in the message", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com/api" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("https://example.com/api");
    });

    it("includes description when provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        description: "My API server",
      });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("My API server");
    });

    it("includes expires_in when provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        expires_in: "24h",
      });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("24h");
    });

    it("includes one_time_use when set to true", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        one_time_use: "true",
      });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("one_time_use: true");
    });

    it("includes max_sessions when provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        max_sessions: "5",
      });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("max_sessions: 5");
    });

    it("instructs to use create_qurl tool", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("create_qurl");
    });

    it("works with only required args", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("target_url: https://example.com");
      expect(text).not.toContain("description:");
      expect(text).not.toContain("expires_in:");
    });
  });
});
