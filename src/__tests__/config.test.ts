import { describe, expect, it } from "vitest";
import { isLoopbackHostname, normalizeServiceBaseUrl, parseSizeBytes } from "../config.js";

describe("service URL security helpers", () => {
  it("recognizes canonical, expanded, mapped, and numeric loopback forms", () => {
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackHostname("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::FFFF:7F00:0001")).toBe(true);
    expect(isLoopbackHostname("127.255.255.255")).toBe(true);
    expect(isLoopbackHostname(new URL("http://2130706433:8080").hostname)).toBe(true);
  });

  it("rejects public IPv4 and IPv6 hosts from the loopback set", () => {
    expect(isLoopbackHostname("192.0.2.1")).toBe(false);
    expect(isLoopbackHostname("2001:db8::1")).toBe(false);
  });

  it.each([
    "https://user:pass@api.example.com",
    "https://api.example.com?target=other",
    "https://api.example.com/#fragment",
    "https://api.example.com/tenant/../admin",
    "https://api.example.com/tenant/%2e%2e/admin",
  ])("rejects unsafe service URL form %s", (value) => {
    expect(() => normalizeServiceBaseUrl(value, "serviceUrl", true)).toThrow();
  });

  it("allows HTTPS and literal loopback HTTP service URLs", () => {
    expect(normalizeServiceBaseUrl("https://api.example.com/v1/", "serviceUrl", true)).toBe(
      "https://api.example.com/v1",
    );
    expect(normalizeServiceBaseUrl("http://127.0.0.1:8080", "serviceUrl", true)).toBe(
      "http://127.0.0.1:8080",
    );
  });
});

describe("parseSizeBytes", () => {
  it("parses byte units and uses the fallback only when unset", () => {
    expect(parseSizeBytes(undefined, 42, "size")).toBe(42);
    expect(parseSizeBytes("16b", 1, "size")).toBe(16);
    expect(parseSizeBytes("2kb", 1, "size")).toBe(2 * 1024);
    expect(parseSizeBytes("1.5mb", 1, "size")).toBe(1.5 * 1024 * 1024);
    expect(() => parseSizeBytes("1.5b", 1, "size")).toThrow("whole number of bytes");
  });

  it("rejects zero, negative, and malformed sizes", () => {
    expect(() => parseSizeBytes(0, 1, "size")).toThrow("positive number");
    expect(() => parseSizeBytes(-1, 1, "size")).toThrow("positive number");
    expect(() => parseSizeBytes("0mb", 1, "size")).toThrow("positive byte size");
    expect(() => parseSizeBytes("many", 1, "size")).toThrow("positive byte size");
  });

  it("rejects numeric strings outside the safe integer range", () => {
    expect(() => parseSizeBytes("9007199254740992", 1, "size")).toThrow(
      "must be a positive number",
    );
  });
});
