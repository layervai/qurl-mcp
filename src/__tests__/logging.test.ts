import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatErrorForLog,
  installTimestampedConsole,
  logInfo,
  sanitizeLogValue,
} from "../logging.js";

describe("logging", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes server timestamps in UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T06:30:45.123Z"));
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    logInfo("ready");

    expect(write).toHaveBeenCalledWith("2026-07-10 06:30:45.123 UTC ready\n");
  });

  it("redacts credentials from informational logs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T06:30:45.123Z"));
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    logInfo("request Bearer secret-token used lv_live_secret");

    expect(write).toHaveBeenCalledWith(
      "2026-07-10 06:30:45.123 UTC request Bearer [REDACTED] used [REDACTED]\n",
    );
  });

  it("redacts documented qURL key shapes and flattens untrusted error text", () => {
    expect(sanitizeLogValue("Bearer secret-token\nlv_live_secret")).toBe(
      "Bearer [REDACTED] [REDACTED]",
    );
    expect(formatErrorForLog(new Error("failed with lv_live_secret\r\nnext"))).toBe(
      "Error: failed with [REDACTED]  next",
    );
    expect(sanitizeLogValue("Bearer opaque:token;tail next")).toBe("Bearer [REDACTED] next");
    expect(sanitizeLogValue("prefixlv_live_secret suffix")).toBe("prefix[REDACTED] suffix");
    for (const documentedKey of ["lv_live_AbC123_-", "lv_test_987zyx-_"]) {
      expect(sanitizeLogValue(`SDK-format key ${documentedKey}`)).toBe("SDK-format key [REDACTED]");
    }
  });

  it("bounds every untrusted string log value to 512 characters", () => {
    expect(sanitizeLogValue("x".repeat(1_000))).toHaveLength(512);
  });

  it("bounds an entire multi-argument console call at the logging boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T06:30:45.123Z"));
    const methods = ["log", "info", "debug", "warn", "error"] as const;
    const descriptors = new Map(
      methods.map((method) => [method, Object.getOwnPropertyDescriptor(console, method)]),
    );
    const patchFlag = Symbol.for("qurl-mcp.consoleTimestampPatched");
    const sink = vi.fn();

    Object.defineProperty(console, "error", { configurable: true, value: sink, writable: true });
    try {
      installTimestampedConsole();
      console.warn(...Array.from({ length: 20 }, () => "x".repeat(100)), "lv_live_secret");

      const rendered = sink.mock.calls[0]?.[0];
      expect(typeof rendered).toBe("string");
      expect(rendered).toHaveLength("2026-07-10 06:30:45.123 UTC ".length + 512);
      expect(rendered).not.toContain("lv_live_secret");
    } finally {
      for (const method of methods) {
        const descriptor = descriptors.get(method);
        if (descriptor) Object.defineProperty(console, method, descriptor);
      }
      delete (console as typeof console & { [patchFlag]?: boolean })[patchFlag];
    }
  });

  it("collapses structured console context instead of deep-formatting credentials", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T06:30:45.123Z"));
    const methods = ["log", "info", "debug", "warn", "error"] as const;
    const descriptors = new Map(
      methods.map((method) => [method, Object.getOwnPropertyDescriptor(console, method)]),
    );
    const patchFlag = Symbol.for("qurl-mcp.consoleTimestampPatched");
    const sink = vi.fn();

    Object.defineProperty(console, "error", { configurable: true, value: sink, writable: true });
    try {
      installTimestampedConsole();
      console.error("request failed", { apiKey: "lv_live_nested_secret" });

      expect(sink).toHaveBeenCalledWith(
        "2026-07-10 06:30:45.123 UTC request failed [object Object]",
      );
      expect(sink.mock.calls.flat().join(" ")).not.toContain("lv_live_nested_secret");
    } finally {
      for (const method of methods) {
        const descriptor = descriptors.get(method);
        if (descriptor) Object.defineProperty(console, method, descriptor);
      }
      delete (console as typeof console & { [patchFlag]?: boolean })[patchFlag];
    }
  });
});
