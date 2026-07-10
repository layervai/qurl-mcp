import { readFileSync } from "node:fs";
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

  it("keeps dynamic renderer values inside quoted HTML attributes", () => {
    for (const sourcePath of ["src/services/legal-pages.ts", "src/services/video-page.ts"]) {
      const source = readFileSync(sourcePath, "utf8");
      // escapeHtml is safe for text and quoted attributes, not for unquoted
      // attribute contexts. Pin that load-bearing renderer convention.
      const unquotedInterpolations = source.match(
        /\b[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?!["'])[^>\s]*\$\{/g,
      );
      expect(unquotedInterpolations, sourcePath).toBeNull();
    }
  });
});
