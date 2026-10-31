import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  durationSchema,
  MAX_EXPIRY_MS,
  MAX_SESSION_MS,
  MIN_SESSION_MS,
  MIN_EXPIRY_MS,
  parseDurationMs,
} from "../../tools/duration.js";

describe("parseDurationMs", () => {
  it.each([
    ["30m", 1_800_000],
    ["1s0.6ns0.6ns", 1000],
    ["1.0000000005s", 1000],
    ["2.0000000009999999s", 2000],
    ["720h0.9ns", 30 * 86_400_000],
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

  it("rejects mixed day and Go units, as qurl-service does (Atoi fails, then Go rejects d)", () => {
    expect(parseDurationMs("1d12h")).toBeUndefined();
  });

  it("accepts micro sign U+00B5 but, as a deliberate subset of qurl-service (Go also takes it), not Greek mu U+03BC", () => {
    expect(parseDurationMs("1000\u00b5s")).toBe(1);
    expect(parseDurationMs("1000\u03bcs")).toBeUndefined();
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
    // One issue, with the same guidance a syntax error gets.
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "Use a duration like '30m', '24h', or '7d'",
    ]);
  });
  it("reports one syntax instruction for an empty duration", () => {
    expect(expiry.safeParse("").error?.issues.map((issue) => issue.message)).toEqual([
      "Use a duration like '30m', '24h', or '7d'",
    ]);
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

// The producer's weekly/PR workflow checks these same public data against real Go code.
const producerContract = JSON.parse(
  readFileSync(new URL("../../../api-spec/duration-contract.json", import.meta.url), "utf8"),
) as {
  format_version: number;
  producer_parser_sha256: string;
  stdlib_parser_sha256: string;
  min_expiry_ms: number;
  max_expiry_ms: number;
  min_session_ms: number;
  max_session_ms: number;
  cases: { input: string; upstream_ms: number | null; mcp_ms: number | null }[];
};

describe("producer duration contract", () => {
  it("pins the grammar algorithms and all four service bounds", () => {
    expect(producerContract.format_version).toBe(1);
    expect(producerContract.producer_parser_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(producerContract.stdlib_parser_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([MIN_EXPIRY_MS, MAX_EXPIRY_MS, MIN_SESSION_MS, MAX_SESSION_MS]).toEqual([
      producerContract.min_expiry_ms,
      producerContract.max_expiry_ms,
      producerContract.min_session_ms,
      producerContract.max_session_ms,
    ]);
    expect(producerContract.cases.length).toBeGreaterThan(0);
    expect(new Set(producerContract.cases.map((entry) => entry.input)).size).toBe(
      producerContract.cases.length,
    );
  });

  it.each(producerContract.cases)("matches the producer corpus for $input", (entry) => {
    const value = parseDurationMs(entry.input) ?? null;
    expect(value).toBe(entry.mcp_ms);
    if (value !== null && value >= 0 && value <= MAX_EXPIRY_MS)
      expect(value).toBe(entry.upstream_ms);
  });
});
