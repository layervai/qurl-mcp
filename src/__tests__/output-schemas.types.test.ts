import { describe, it, expectTypeOf } from "vitest";
import type { z } from "zod";
import type {
  CreateQURLData,
  ListQURLsOutput,
  MintLinkOutput,
  QURL,
  ResolveOutput,
} from "../client.js";
import {
  createQurlOutputSchema,
  listQurlsOutputSchema,
  mintLinkOutputSchema,
  qurlSchema,
  resolveQurlOutputSchema,
} from "../tools/output-schemas.js";

// Lock each Zod output schema to its corresponding client interface so a
// new field on either side breaks compilation. The MCP-spec-drift workflow
// covers external (API <-> snapshot) drift; this guards internal
// (client.ts <-> output-schemas.ts) drift.
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
});
