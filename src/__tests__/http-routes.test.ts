import { describe, expect, it } from "vitest";
import {
  HEALTH_HTTP_PATH,
  LEGAL_HTTP_PATH_PREFIX,
  MCP_HTTP_PATH,
  RESERVED_PUBLIC_PATH_PREFIXES,
} from "../http-routes.js";

describe("HTTP route constants", () => {
  it("keeps every reserved public prefix derived from the protected routes", () => {
    expect(RESERVED_PUBLIC_PATH_PREFIXES).toEqual([
      MCP_HTTP_PATH,
      HEALTH_HTTP_PATH,
      LEGAL_HTTP_PATH_PREFIX,
    ]);
    expect(new Set(RESERVED_PUBLIC_PATH_PREFIXES).size).toBe(RESERVED_PUBLIC_PATH_PREFIXES.length);
  });

  it("uses absolute paths for every protected route", () => {
    for (const path of RESERVED_PUBLIC_PATH_PREFIXES) {
      expect(path).toMatch(/^\/[a-z0-9/-]+$/);
    }
  });
});
