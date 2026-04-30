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
import { sampleAccessToken, sampleQURL } from "./helpers.js";

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
  it("accepts 'active', 'revoked', and 'expired' as-is", () => {
    // "expired" round-trips because the spec's status description
    // (api-spec/qurls.yaml:2745-2746) documents it as a real lifecycle
    // value despite the spec's `enum:` line missing it. Coercing it to
    // the drift sentinel would lose semantics agents care about.
    expect(qurlSchema.parse(sampleQURL({ status: "active" })).status).toBe("active");
    expect(qurlSchema.parse(sampleQURL({ status: "revoked" })).status).toBe("revoked");
    expect(qurlSchema.parse(sampleQURL({ status: "expired" })).status).toBe("expired");
  });

  it("coerces an unrecognized status to 'unknown' via .catch()", () => {
    // QURL.status doesn't include "pending" — the fixture deliberately
    // violates the type to stand in for an API response with a
    // future-added enum value. @ts-expect-error documents the violation
    // at the source and would itself fail if QURL.status ever widens to
    // accept "pending" (at which point this test should be revisited).
    const parsed = qurlSchema.parse({
      ...sampleQURL(),
      // @ts-expect-error simulating an out-of-spec API value
      status: "pending",
    });
    expect(parsed.status).toBe("unknown");
  });

  it("coerces null / wrong-type / missing status to 'unknown' via .catch()", () => {
    // `.catch()` triggers on ANY parse failure for the field — not just
    // unrecognized enum strings. Lock that broader scope in so a future
    // refactor that narrows the catch (e.g. via a custom handler that
    // only coerces strings) trips this test rather than silently hard-
    // failing structuredContent for null/wrong-type values an upstream
    // bug might emit.
    expect(
      qurlSchema.parse({
        ...sampleQURL(),
        // @ts-expect-error simulating null on a string-enum field
        status: null,
      }).status,
    ).toBe("unknown");
    expect(
      qurlSchema.parse({
        ...sampleQURL(),
        // @ts-expect-error simulating a non-string value
        status: 42,
      }).status,
    ).toBe("unknown");
    const { status: _drop, ...withoutStatus } = sampleQURL();
    void _drop;
    expect(qurlSchema.parse(withoutStatus as Record<string, unknown>).status).toBe("unknown");
  });

  it("accepts the documented access-token statuses on the nested array", () => {
    // Symmetric pass-through assertion for the wider nested enum.
    // Cheap insurance against an enum typo on accessTokenSchema.
    for (const s of ["active", "consumed", "expired", "revoked"] as const) {
      const parsed = qurlSchema.parse({
        ...sampleQURL(),
        qurls: [sampleAccessToken({ status: s })],
      });
      expect(parsed.qurls?.[0].status).toBe(s);
    }
  });

  it("coerces nested access-token unrecognized status to 'unknown' via .catch()", () => {
    // The API side has 4 status values today (active/consumed/expired/
    // revoked); a future-added value would otherwise hard-fail nested
    // `qurls` parse. Lock the behavior in symmetrically so a refactor
    // that strips .catch from accessTokenSchema also fails this test.
    const parsed = qurlSchema.parse({
      ...sampleQURL(),
      // @ts-expect-error simulating an out-of-spec API value on the nested token
      qurls: [sampleAccessToken({ status: "future-state" })],
    });
    expect(parsed.qurls?.[0].status).toBe("unknown");
  });
});
