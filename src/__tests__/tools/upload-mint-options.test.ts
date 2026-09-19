import { describe, expect, it } from "vitest";
import { z } from "zod";
import { uploadMintOptionsShape } from "../../tools/upload-mint-options.js";

const uploadMintOptionsSchema = z.object(uploadMintOptionsShape).strict();

describe("uploadMintOptionsShape", () => {
  it("accepts the shared upload mint options", () => {
    const options = {
      label: "Quarterly report",
      expires_in: "24h",
      one_time_use: false,
      session_duration: "1h",
    };
    expect(uploadMintOptionsSchema.parse(options)).toEqual(options);
  });

  it("accepts an empty option set and rejects unknown fields", () => {
    expect(uploadMintOptionsSchema.parse({})).toEqual({});
    expect(uploadMintOptionsSchema.safeParse({ typo: true }).success).toBe(false);
  });

  // Regression (qurl-mcp#278): the connector's mint contract cannot carry these,
  // so they must fail loudly instead of minting an unrestricted link.
  it.each([
    { field: "access_policy", value: { geo_allowlist: ["US"] } },
    { field: "max_sessions", value: 3 },
  ])("rejects $field because uploaded-file links cannot enforce it", ({ field, value }) => {
    const result = z.object(uploadMintOptionsShape).safeParse({ [field]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(`${field} is not supported for uploaded files`);
  });

  it.each([
    { description: "an empty label", input: { label: "" } },
    { description: "an empty expiry", input: { expires_in: "" } },
    { description: "a malformed expiry", input: { expires_in: "banana" } },
    { description: "a unitless expiry", input: { expires_in: "24" } },
    { description: "an empty session duration", input: { session_duration: "" } },
    { description: "a malformed session duration", input: { session_duration: "1 hour" } },
    // Bounds: an overflowing value used to pass and then throw after upload.
    { description: "an overflowing expiry", input: { expires_in: "999999999d" } },
    { description: "an expiry past the 30-day ceiling", input: { expires_in: "31d" } },
    { description: "an expiry under a minute", input: { expires_in: "30s" } },
    { description: "a session over 24h", input: { session_duration: "25h" } },
  ])("rejects $description", ({ input }) => {
    expect(uploadMintOptionsSchema.safeParse(input).success).toBe(false);
  });
});
