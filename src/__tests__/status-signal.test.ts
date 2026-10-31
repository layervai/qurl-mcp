import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { accessTokenOutputSchema, qurlSchema } from "../tools/output-schemas.js";
import { sampleAccessToken, sampleQURL } from "./helpers.js";

let minute = 0;
beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2030, 0, 1) + ++minute * 120_001 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

for (const [field, schema, fixture] of [
  ["resource.status", qurlSchema, sampleQURL()],
  ["token.status", accessTokenOutputSchema, sampleAccessToken()],
] as const) {
  describe(field, () => {
    it.each([
      ["pending", "coerced", '"pending"'],
      [undefined, "coerced", "undefined"],
      [null, "coerced", "null"],
      [42, "coerced", "42"],
      ["unknown", "wire_unknown", '"unknown"'],
    ])("reports raw input %j without changing the fallback", (status, reason, raw) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(schema.parse({ ...fixture, status }).status).toBe("unknown");
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        `[qurl-mcp] status signal field=${field} reason=${reason} input=${raw}`,
      );
    });

    it("reports each distinct signal once per minute", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (let i = 0; i < 500; i++) schema.parse({ ...fixture, status: "pending" });
      schema.parse({ ...fixture, status: undefined });
      expect(warn).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      schema.parse({ ...fixture, status: "pending" });
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("caps distinct warnings and resumes in the next minute", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (let i = 0; i < 150; i++) schema.parse({ ...fixture, status: `future_${i}` });
      expect(warn).toHaveBeenCalledTimes(100);
      vi.advanceTimersByTime(60_000);
      schema.parse({ ...fixture, status: "pending" });
      expect(warn).toHaveBeenCalledTimes(101);
    });

    it("does not warn for known lifecycle values", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(schema.parse({ ...fixture, status: "active" }).status).toBe("active");
      expect(warn).not.toHaveBeenCalled();
    });

    it("bounds and redacts scalar warnings", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      schema.parse({ ...fixture, status: `lv_live_fixture_secret\n${"x".repeat(2000)}` });
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain("lv_live_fixture_secret");
      expect(message).not.toContain("\n");
      expect(message.length).toBeLessThan(650);
    });

    it("does not log or serialize arbitrary malformed objects", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const toJSON = vi.fn(() => {
        throw new Error("must not run");
      });
      schema.parse({ ...fixture, status: { credential: "opaque-secret", toJSON } });
      expect(toJSON).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        `[qurl-mcp] status signal field=${field} reason=coerced input=[non-scalar]`,
      );
    });

    it("keeps the status schema serializable for tools/list", () => {
      for (const io of ["input", "output"] as const) {
        expect(z.toJSONSchema(schema, { io }).properties?.status).toMatchObject({
          enum: expect.arrayContaining(["active", "unknown"]),
        });
      }
    });
  });
}
