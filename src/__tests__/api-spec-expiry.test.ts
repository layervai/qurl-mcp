import { describe, expect, it } from "vitest";
import { readApiSpec } from "./helpers.js";

describe("customer link lifetime API snapshot", () => {
  it("keeps the shared 30-day maximum when refreshing the snapshot", () => {
    const spec = readApiSpec();
    expect(spec.match(/Maximum: 30 days on all plans\./g)).toHaveLength(2);
    expect(spec).toContain(
      "Maximum expiry duration in seconds (2592000, or 30 days, on all customer plans)",
    );
    expect(spec).not.toContain("free=3 days");
    expect(spec).not.toContain("free=259200/");
  });
});
