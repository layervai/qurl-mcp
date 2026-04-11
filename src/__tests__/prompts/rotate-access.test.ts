import { describe, it, expect } from "vitest";
import { rotateAccessPrompt } from "../../prompts/rotate-access.js";
import { getPromptText } from "../helpers.js";

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

      expect(getPromptText(result)).toContain("r_abc456");
    });

    it("instructs to use get_qurl tool", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });

      expect(getPromptText(result)).toContain("get_qurl");
    });

    it("instructs to use delete_qurl tool", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });

      expect(getPromptText(result)).toContain("delete_qurl");
    });

    it("instructs to use create_qurl tool", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });

      expect(getPromptText(result)).toContain("create_qurl");
    });

    it("mentions mint_link as alternative", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });

      expect(getPromptText(result)).toContain("mint_link");
    });

    it("defaults to 24h expiry when not specified", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });

      expect(getPromptText(result)).toContain('"24h"');
    });

    it("uses custom expiry when provided", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({
        resource_id: "r_test123",
        expires_in: "168h",
      });

      expect(getPromptText(result)).toContain('"168h"');
    });

    it("includes step-by-step instructions", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = getPromptText(result);

      expect(text).toContain("1.");
      expect(text).toContain("2.");
      expect(text).toContain("3.");
      expect(text).toContain("4.");
      expect(text).toContain("5.");
      expect(text).toContain("6.");
    });

    it("instructs to use update_qurl to restore tags/description", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = getPromptText(result);

      expect(text).toContain("update_qurl");
    });

    it("does not reference non-existent fields on create_qurl", () => {
      const prompt = rotateAccessPrompt();
      const result = prompt.handler({ resource_id: "r_test123" });
      const text = getPromptText(result);

      // `metadata` is not a field on QurlData or CreateQURLInput
      expect(text).not.toContain("metadata");
    });
  });
});
