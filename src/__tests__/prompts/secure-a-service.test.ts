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
      expect(text).not.toContain("access_policy:");
    });

    it("emits ip_allowlist in the access_policy block", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        ip_allowlist: "10.0.0.0/8, 192.168.1.1",
      });
      const text = getPromptText(result);

      expect(text).toContain("access_policy:");
      expect(text).toContain('"ip_allowlist":["10.0.0.0/8","192.168.1.1"]');
    });

    it("emits geo_allowlist and geo_denylist together", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        geo_allowlist: "US,CA",
        geo_denylist: "CN,RU",
      });
      const text = getPromptText(result);

      expect(text).toContain('"geo_allowlist":["US","CA"]');
      expect(text).toContain('"geo_denylist":["CN","RU"]');
    });

    it("emits ai_agent_policy when block_ai_agents is true", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        block_ai_agents: "true",
      });
      const text = getPromptText(result);

      expect(text).toContain('"ai_agent_policy":{"block_all":true}');
    });

    it("omits access_policy block when block_ai_agents is false", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        block_ai_agents: "false",
      });
      const text = getPromptText(result);

      expect(text).not.toContain("access_policy:");
    });

    it("filters out empty strings from comma-separated policy lists", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        ip_allowlist: "10.0.0.0/8,,  ,192.168.1.1",
      });
      const text = getPromptText(result);

      expect(text).toContain('"ip_allowlist":["10.0.0.0/8","192.168.1.1"]');
    });

    it("does not list description as a create_qurl parameter", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        description: "An internal dashboard",
      });
      const text = getPromptText(result);

      // description is not a valid create_qurl field; it must be applied via update_qurl.
      expect(text).not.toContain("- description:");
    });

    it("instructs to use update_qurl to set description after create", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({
        target_url: "https://example.com",
        description: "An internal dashboard",
      });
      const text = getPromptText(result);

      expect(text).toContain("update_qurl");
      expect(text).toContain("An internal dashboard");
    });

    it("omits the update_qurl follow-up when no description is provided", () => {
      const prompt = secureAServicePrompt();
      const result = prompt.handler({ target_url: "https://example.com" });
      const text = getPromptText(result);

      expect(text).not.toContain("update_qurl");
    });
  });
});
