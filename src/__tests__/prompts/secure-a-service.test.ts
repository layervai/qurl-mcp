import { describe, it, expect } from "vitest";
import { secureAServicePrompt } from "../../prompts/secure-a-service.js";
import { getPromptText } from "../helpers.js";

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

      expect(getPromptText(result)).toContain("https://example.com/api");
    });

    it("includes label when provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        label: "Alice from Acme",
      });

      expect(getPromptText(result)).toContain("Alice from Acme");
    });

    it("includes expires_in when provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        expires_in: "24h",
      });

      expect(getPromptText(result)).toContain("24h");
    });

    it("includes session_duration when provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        session_duration: "1h",
      });

      expect(getPromptText(result)).toContain("session_duration: 1h");
    });

    it("includes tags when provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        tags: "prod,api",
      });

      expect(getPromptText(result)).toContain("prod,api");
    });

    it("instructs to use create_qurl tool", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com" });

      expect(getPromptText(result)).toContain("create_qurl");
    });

    it("mentions qurl_link is ephemeral", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com" });

      expect(getPromptText(result)).toContain("ephemeral");
    });

    it("works with only required args", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com" });
      const text = getPromptText(result);

      expect(text).toContain("target_url: https://example.com");
      expect(text).not.toContain("label:");
      expect(text).not.toContain("expires_in:");
    });
  });
});
