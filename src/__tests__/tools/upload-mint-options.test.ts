import { describe, expect, it } from "vitest";
import { z } from "zod";
import { uploadMintOptionsShape } from "../../tools/upload-mint-options.js";

const uploadMintOptionsSchema = z.object(uploadMintOptionsShape).strict();

describe("uploadMintOptionsShape", () => {
  it("accepts the shared upload mint options", () => {
    expect(
      uploadMintOptionsSchema.parse({
        label: "Quarterly report",
        expires_in: "24h",
        one_time_use: false,
        max_sessions: 25,
        session_duration: "1h",
        access_policy: { ip_allowlist: ["192.0.2.10"] },
      }),
    ).toEqual({
      label: "Quarterly report",
      expires_in: "24h",
      one_time_use: false,
      max_sessions: 25,
      session_duration: "1h",
      access_policy: { ip_allowlist: ["192.0.2.10"] },
    });
  });

  it("accepts an empty option set and rejects unknown fields", () => {
    expect(uploadMintOptionsSchema.parse({})).toEqual({});
    expect(uploadMintOptionsSchema.safeParse({ typo: true }).success).toBe(false);
  });

  it.each([
    { description: "an empty label", input: { label: "" } },
    { description: "negative sessions", input: { max_sessions: -1 } },
    { description: "fractional sessions", input: { max_sessions: 1.5 } },
    { description: "sessions above the API ceiling", input: { max_sessions: 1001 } },
    { description: "an empty expiry", input: { expires_in: "" } },
    { description: "an empty session duration", input: { session_duration: "" } },
  ])("rejects $description", ({ input }) => {
    expect(uploadMintOptionsSchema.safeParse(input).success).toBe(false);
  });
});
