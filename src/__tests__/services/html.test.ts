import { describe, expect, it } from "vitest";
import { escapeHtml, escapeHttpUrlAttribute } from "../../services/html.js";

describe("HTML helpers", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("preserves plain text and handles empty input", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
    expect(escapeHtml("")).toBe("");
  });

  it("allows escaped HTTP URL attributes and rejects active or credentialed schemes", () => {
    expect(escapeHttpUrlAttribute("https://example.com/?a=1&b=2")).toBe(
      "https://example.com/?a=1&amp;b=2",
    );
    expect(() => escapeHttpUrlAttribute("javascript:alert(1)")).toThrow("absolute HTTP(S)");
    expect(() => escapeHttpUrlAttribute("data:text/html,unsafe")).toThrow("absolute HTTP(S)");
    expect(() => escapeHttpUrlAttribute("https://user:secret@example.com")).toThrow(
      "absolute HTTP(S)",
    );
  });
});
