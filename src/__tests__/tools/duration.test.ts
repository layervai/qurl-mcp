import { describe, expect, it } from "vitest";
import {
  durationSchema,
  MAX_EXPIRY_MS,
  MIN_EXPIRY_MS,
  parseDurationMs,
} from "../../tools/duration.js";

describe("parseDurationMs", () => {
  it.each([
    ["30m", 1_800_000],
    ["24h", 86_400_000],
    ["1h30m", 5_400_000],
    ["1.5h", 5_400_000],
    ["7d", 604_800_000],
    ["1w", 604_800_000],
    ["1500ms", 1_500],
    ["2000000us", 2_000],
    ["3000000µs", 3_000],
    ["4000000000ns", 4_000],
    ["60000000000ns", 60_000],
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

describe("durationSchema", () => {
  const expiry = durationSchema(MIN_EXPIRY_MS, MAX_EXPIRY_MS, "1m to 30d");
  it.each(["1m", "24h", "30d"])("accepts %s within 1m-30d", (value) => {
    expect(expiry.safeParse(value).success).toBe(true);
  });
  it.each(["59s", "31d", "0s"])("rejects %s outside 1m-30d", (value) => {
    expect(expiry.safeParse(value).success).toBe(false);
  });
  it("rejects an oversized input before parsing it", () => {
    const result = expiry.safeParse("1h".repeat(100));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("too_big");
  });
  it("tells a syntax error apart from an out-of-range value", () => {
    expect(expiry.safeParse("banana").error?.issues.map((issue) => issue.message)).toEqual([
      "Use a duration like '30m', '24h', or '7d'",
    ]);
    expect(expiry.safeParse("31d").error?.issues.map((issue) => issue.message)).toEqual([
      "Duration must be 1m to 30d",
    ]);
  });
});
