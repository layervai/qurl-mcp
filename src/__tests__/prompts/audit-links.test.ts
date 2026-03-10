import { describe, it, expect } from "vitest";
import { auditLinksPrompt } from "../../prompts/audit-links.js";

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
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("list_qurls");
    });

    it("includes expiration check instructions", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("expiring");
    });

    it("includes access count evaluation", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("access_count");
    });

    it("includes one_time_use check", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("one_time_use");
    });

    it("asks for a summary table", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("table");
    });

    it("recommends actions", () => {
      const prompt = auditLinksPrompt();
      const result = prompt.handler();
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("Recommend actions");
    });
  });
});
