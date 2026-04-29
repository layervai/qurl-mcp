import { describe, it, expect, expectTypeOf } from "vitest";
import type { z } from "zod";
import type {
  BatchCreateOutput,
  CreateQURLData,
  ListQURLsOutput,
  MintLinkOutput,
  QURL,
  ResolveOutput,
} from "../client.js";
import {
  batchCreateOutputSchema,
  createQurlOutputSchema,
  listQurlsOutputSchema,
  mintLinkOutputSchema,
  qurlSchema,
  resolveQurlOutputSchema,
} from "../tools/output-schemas.js";
import { sampleQURL } from "./helpers.js";

// Lock each Zod output schema to its corresponding client interface so a
// new field on either side breaks compilation. The MCP-spec-drift workflow
// covers external (API <-> snapshot) drift; this guards internal
// (client.ts <-> output-schemas.ts) drift.
//
// `deleteQurlOutputSchema` is intentionally omitted (no client-side
// interface — the client returns `Promise<void>` and the handler
// synthesizes the payload).
describe("output schema <-> client type alignment", () => {
  it("qurlSchema matches QURL", () => {
    expectTypeOf<z.infer<typeof qurlSchema>>().toEqualTypeOf<QURL>();
  });

  it("createQurlOutputSchema matches CreateQURLData", () => {
    expectTypeOf<z.infer<typeof createQurlOutputSchema>>().toEqualTypeOf<CreateQURLData>();
  });

  it("listQurlsOutputSchema matches ListQURLsOutput", () => {
    expectTypeOf<z.infer<typeof listQurlsOutputSchema>>().toEqualTypeOf<ListQURLsOutput>();
  });

  it("resolveQurlOutputSchema matches ResolveOutput", () => {
    expectTypeOf<z.infer<typeof resolveQurlOutputSchema>>().toEqualTypeOf<ResolveOutput>();
  });

  it("mintLinkOutputSchema matches MintLinkOutput", () => {
    expectTypeOf<z.infer<typeof mintLinkOutputSchema>>().toEqualTypeOf<MintLinkOutput>();
  });

  it("batchCreateOutputSchema matches the flattened BatchCreateOutput.data + request_id", () => {
    // Schema flattens the `{ data, meta }` envelope; assert against the
    // flattened shape so a new field on `BatchCreateOutput.data` is a
    // compile error here.
    type FlatBatchPayload = BatchCreateOutput["data"] & { request_id?: string };
    expectTypeOf<z.infer<typeof batchCreateOutputSchema>>().toEqualTypeOf<FlatBatchPayload>();
  });
});

// `.catch("unknown")` lets the schema absorb a future API value the spec
// snapshot doesn't enumerate (e.g. "expired", "pending") instead of
// hard-failing structuredContent validation between weekly drift runs.
// Lock the behavior in so a future "fix" that removes the .catch trips
// these tests instead of silently breaking hosts.
describe("qurlSchema.status drift tolerance", () => {
  it("accepts 'active' and 'revoked' as-is", () => {
    expect(qurlSchema.parse(sampleQURL({ status: "active" })).status).toBe("active");
    expect(qurlSchema.parse(sampleQURL({ status: "revoked" })).status).toBe("revoked");
  });

  it("coerces an unrecognized status to 'unknown' via .catch()", () => {
    // QURL.status doesn't include "expired" — the fixture deliberately
    // violates the type to stand in for an API response with a
    // future-added enum value. @ts-expect-error documents the violation
    // at the source and would itself fail if QURL.status ever widens to
    // accept "expired" (at which point this test should be revisited).
    const parsed = qurlSchema.parse({
      ...sampleQURL(),
      // @ts-expect-error simulating an out-of-spec API value
      status: "expired",
    });
    expect(parsed.status).toBe("unknown");
  });
});
