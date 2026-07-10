import { describe, expect, it } from "vitest";
import {
  createPassthroughBearerVerifier,
  PASSTHROUGH_BEARER_CLIENT_ID,
} from "../../auth/static-bearer.js";

describe("passthrough bearer authentication", () => {
  const verifier = createPassthroughBearerVerifier();

  it("rejects an empty bearer token", async () => {
    await expect(verifier.verifyAccessToken("   ")).rejects.toThrow("Invalid or expired token.");
  });

  it("normalizes the caller's qURL API key without duplicating it in metadata", async () => {
    const auth = await verifier.verifyAccessToken("  lv_live_test  ");

    expect(auth.clientId).toBe(PASSTHROUGH_BEARER_CLIENT_ID);
    expect(auth.scopes).toEqual(["mcp:tools"]);
    expect(auth.token).toBe("lv_live_test");
    expect(auth.expiresAt).toBeGreaterThan(4_000_000_000);
    expect(JSON.stringify(auth)).not.toContain("  lv_live_test  ");
  });
});
