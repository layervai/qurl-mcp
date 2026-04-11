import { describe, it, expect } from "vitest";
import { auditLinksPrompt } from "../../prompts/audit-links.js";
import { getPromptText } from "../helpers.js";

describe("auditLinksPrompt", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const prompt = auditLinksPrompt();
      expect(prompt.name).toBe("audit-links");
    });

    it("has a description", () => {
      const prompt = auditLinksPrompt();
      expect(prompt.description).toBeTruthy();
    });
  });

  describe("handler", () => {
    it("returns a single user message", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("instructs to use list_qurls tool", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(getPromptText(result)).toContain("list_qurls");
    });

    it("includes expiration check instructions", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(getPromptText(result)).toContain("expiring");
    });

    it("includes qurl_count evaluation", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(getPromptText(result)).toContain("qurl_count");
    });

    it("includes tags check", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(getPromptText(result)).toContain("tags");
    });

    it("includes custom_domain as informational context", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(getPromptText(result)).toContain("custom_domain");
      // Custom domain should be framed as informational, not as an issue.
      expect(getPromptText(result)).toContain("informational");
    });

    it("asks for a summary table", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(getPromptText(result)).toContain("table");
    });

    it("recommends actions using update_qurl", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();

      expect(getPromptText(result)).toContain("update_qurl");
    });
  });
});
