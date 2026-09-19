import { describe, expect, it } from "vitest";
import { parseDurationMs } from "../../tools/duration.js";

describe("parseDurationMs", () => {
  it.each([
    ["30m", 1_800_000],
    ["24h", 86_400_000],
    ["1h30m", 5_400_000],
    ["1.5h", 5_400_000],
    ["7d", 604_800_000],
    ["1w", 604_800_000],
  ])("parses %s like qurl-service", (value, expected) => {
    expect(parseDurationMs(value)).toBe(expected);
  });

  it("returns the magnitude for oversized values so callers can bound them", () => {
    expect(parseDurationMs("999999999d")).toBe(999_999_999 * 86_400_000);
  });

  it.each(["", "banana", "24", "1.5d", "-1h", "1 h"])("rejects %j", (value) => {
    expect(parseDurationMs(value)).toBeUndefined();
  });
});
