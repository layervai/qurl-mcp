import { describe, expect, it } from "vitest";
import {
  isEmailAddress,
  normalizeEmailAddress,
  normalizeEmailDomain,
  uniqueRecipients,
} from "../email-addresses.js";

describe("email address normalization", () => {
  it("canonicalizes IDNA domains, Unicode form, case, and a trailing root dot", () => {
    expect(normalizeEmailDomain("BÜCHER.Example.")).toBe("xn--bcher-kva.example");
    expect(normalizeEmailAddress(" Alice@BÜCHER.Example. ")).toBe("alice@xn--bcher-kva.example");
    expect(isEmailAddress("Alice@BÜCHER.Example.")).toBe(true);
  });

  it("deduplicates recipients after canonicalization", () => {
    expect(uniqueRecipients(["Alice@BÜCHER.Example.", "alice@xn--bcher-kva.example"])).toEqual([
      "alice@xn--bcher-kva.example",
    ]);
  });

  it("preserves IDNA-invalid domains so validators reject instead of collapsing them", () => {
    expect(normalizeEmailDomain("[invalid]")).toBe("[invalid]");
    expect(normalizeEmailAddress("a@[invalid]")).toBe("a@[invalid]");
    expect(isEmailAddress("a@[invalid]")).toBe(false);
  });
});
