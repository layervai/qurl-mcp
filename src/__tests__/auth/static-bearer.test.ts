import { describe, expect, it } from "vitest";
import {
  canonicalizeBearerToken,
  createPassthroughBearerVerifier,
  PASSTHROUGH_BEARER_CLIENT_ID,
} from "../../auth/static-bearer.js";

describe("passthrough bearer authentication", () => {
  const verifier = createPassthroughBearerVerifier();

  it("rejects an empty bearer token", async () => {
    await expect(verifier.verifyAccessToken("   ")).rejects.toThrow("Invalid or expired token.");
  });

  it("centralizes bearer canonicalization", () => {
    expect(canonicalizeBearerToken("  future.secret+format  ")).toBe("future.secret+format");
    expect(canonicalizeBearerToken("   ")).toBeUndefined();
  });

  it("normalizes the caller's qURL API key without duplicating it in metadata", async () => {
    const auth = await verifier.verifyAccessToken("  lv_live_test  ");

    expect(auth.clientId).toBe(PASSTHROUGH_BEARER_CLIENT_ID);
    expect(auth.scopes).toEqual(["mcp:tools"]);
    expect(auth.token).toBe("lv_live_test");
    expect(auth.expiresAt).toBe(Date.UTC(2100, 0, 1) / 1000);
    expect(JSON.stringify(auth)).not.toContain("  lv_live_test  ");
  });
});
