import { describe, it, expect } from "vitest";
import { rotateAccessPrompt } from "../../prompts/rotate-access.js";

describe("rotateAccessPrompt", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const prompt = rotateAccessPrompt();
      expect(prompt.name).toBe("rotate-access");
    });

    it("has a description", () => {
      const prompt = rotateAccessPrompt();
      expect(prompt.description).toBeTruthy();
    });

    it("defines args schema with resource_id", () => {
      const prompt = rotateAccessPrompt();
      expect(prompt.args.resource_id).toBeDefined();
    });
  });

  describe("handler", () => {
    it("returns a single user message", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("includes resource_id in the message", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_abc456" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("r_abc456");
    });

    it("instructs to use get_qurl tool", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("get_qurl");
    });

    it("instructs to use delete_qurl tool", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("delete_qurl");
    });

    it("instructs to use create_qurl tool", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("create_qurl");
    });

    it("defaults to 24h expiry when not specified", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain('"24h"');
    });

    it("uses custom expiry when provided", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({
        resource_id: "r_test123",
        extend_expiry: "168h",
      });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain('"168h"');
    });

    it("includes step-by-step instructions", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = (result.messages[0].content as { text: string }).text;

      expect(text).toContain("1.");
      expect(text).toContain("2.");
      expect(text).toContain("3.");
      expect(text).toContain("4.");
      expect(text).toContain("5.");
    });
  });
});
