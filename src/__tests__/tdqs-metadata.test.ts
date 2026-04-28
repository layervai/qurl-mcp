import { describe, it, expect, vi } from "vitest";
import type { IQURLClient } from "../client.js";
import { toolFactories } from "../server.js";
import {
  makeMockClient,
  sampleBatchCreateOutput,
  sampleCreateQURLData,
  sampleMintLinkOutput,
  sampleQURL,
  sampleResolveOutput,
} from "./helpers.js";

const tools = toolFactories.map((factory) => factory(makeMockClient()));
const factoryByName = new Map(
  toolFactories.map((factory) => [factory(makeMockClient()).name, factory] as const),
);

describe("TDQS tool metadata coverage", () => {
  for (const tool of tools) {
    describe(tool.name, () => {
      it("declares a non-empty title", () => {
        expect(tool.title).toBeTruthy();
        expect(typeof tool.title).toBe("string");
      });

      it("has a substantive description (>= 80 chars)", () => {
        expect(tool.description.length).toBeGreaterThanOrEqual(80);
      });

      it("declares an inputSchema as a ZodObject", () => {
        expect(tool.inputSchema).toBeDefined();
        // Duck-type via `.shape` so this stays robust to Zod major-version drift.
        expect(typeof tool.inputSchema.shape).toBe("object");
      });

      it("declares an outputSchema as a ZodObject", () => {
        expect(tool.outputSchema).toBeDefined();
        expect(typeof tool.outputSchema.shape).toBe("object");
        expect(Object.keys(tool.outputSchema.shape).length).toBeGreaterThan(0);
      });

      it("declares all four canonical annotations as booleans", () => {
        expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
        expect(typeof tool.annotations.destructiveHint).toBe("boolean");
        expect(typeof tool.annotations.idempotentHint).toBe("boolean");
        expect(typeof tool.annotations.openWorldHint).toBe("boolean");
      });

      it("sets openWorldHint=true (every tool talks to the qURL API)", () => {
        expect(tool.annotations.openWorldHint).toBe(true);
      });

      it("keeps top-level title and annotations.title in sync", () => {
        // Both fields are spec-distinct (different consumers), but every
        // tool in this repo uses the same string for both. Lock that
        // convention so a future divergence is intentional, not drift.
        expect(tool.annotations.title).toBe(tool.title);
      });
    });
  }

  describe("disambiguation guidance in descriptions", () => {
    // The 80-char floor catches missing rich text but not 200-char fluff.
    // For tools that overlap with siblings, lock in the "Use `xxx` instead"
    // guidance so an inattentive description rewrite can't drop it.
    const expected: Record<string, string[]> = {
      delete_qurl: ["update_qurl"],
      update_qurl: ["extend_qurl", "delete_qurl"],
      extend_qurl: ["update_qurl"],
      mint_link: ["create_qurl", "update_qurl"],
      batch_create_qurls: ["create_qurl"],
    };
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const [name, siblings] of Object.entries(expected)) {
      it(`${name} description references ${siblings.join(", ")}`, () => {
        const description = byName.get(name)?.description ?? "";
        for (const sibling of siblings) {
          expect(description).toContain(sibling);
        }
      });
    }
  });

  describe("safety hints match tool semantics", () => {
    const byName = new Map(tools.map((t) => [t.name, t]));

    it("marks read-only tools as readOnlyHint", () => {
      const readOnlyNames = new Set(["list_qurls", "get_qurl"]);
      for (const tool of tools) {
        if (readOnlyNames.has(tool.name)) {
          expect(tool.annotations.readOnlyHint).toBe(true);
          expect(tool.annotations.destructiveHint).toBe(false);
        } else {
          expect(tool.annotations.readOnlyHint).toBe(false);
        }
      }
    });

    it("marks delete_qurl as destructiveHint", () => {
      expect(byName.get("delete_qurl")?.annotations.destructiveHint).toBe(true);
    });
  });
});

/**
 * Round-trip contract for every tool: `structuredContent` validates
 * against the declared `outputSchema`, and (where text is JSON) the two
 * views agree. Without this, schema/handler drift would only fail at
 * host call time. delete_qurl is an intentional exception — its text is
 * a human-readable confirmation, not the JSON payload.
 */
describe("structuredContent ↔ outputSchema round-trip", () => {
  type Case = {
    // Generic over 9 schemas, so input is loosely typed; per-tool tests
    // exercise the strict input schema.
    input: Record<string, unknown>;
    clientOverrides: Partial<IQURLClient>;
    textIsJson?: boolean;
  };

  const qurlFixture = sampleQURL();
  const cases: Record<string, Case> = {
    create_qurl: {
      input: { target_url: "https://example.com" },
      clientOverrides: {
        createQURL: vi.fn().mockResolvedValue({ data: sampleCreateQURLData() }),
      },
    },
    resolve_qurl: {
      input: { access_token: "at_abc123def456" },
      clientOverrides: {
        resolveQURL: vi.fn().mockResolvedValue({ data: sampleResolveOutput() }),
      },
    },
    list_qurls: {
      input: {},
      clientOverrides: {
        listQURLs: vi.fn().mockResolvedValue({ data: [qurlFixture], meta: { has_more: false } }),
      },
    },
    get_qurl: {
      input: { resource_id: "r_test123" },
      clientOverrides: { getQURL: vi.fn().mockResolvedValue({ data: qurlFixture }) },
    },
    delete_qurl: {
      input: { resource_id: "r_test123" },
      clientOverrides: { deleteQURL: vi.fn().mockResolvedValue(undefined) },
      textIsJson: false,
    },
    extend_qurl: {
      input: { resource_id: "r_test123", extend_by: "24h" },
      clientOverrides: { extendQURL: vi.fn().mockResolvedValue({ data: qurlFixture }) },
    },
    update_qurl: {
      input: { resource_id: "r_test123", extend_by: "24h" },
      clientOverrides: { updateQURL: vi.fn().mockResolvedValue({ data: qurlFixture }) },
    },
    mint_link: {
      input: { resource_id: "r_test123" },
      clientOverrides: {
        mintLink: vi.fn().mockResolvedValue({ data: sampleMintLinkOutput() }),
      },
    },
    batch_create_qurls: {
      input: { items: [{ target_url: "https://example.com" }] },
      clientOverrides: { batchCreate: vi.fn().mockResolvedValue(sampleBatchCreateOutput()) },
    },
  };

  for (const [name, { input, clientOverrides, textIsJson = true }] of Object.entries(cases)) {
    it(`${name} structuredContent validates against outputSchema`, async () => {
      const factory = factoryByName.get(name);
      if (!factory) throw new Error(`Unknown tool ${name}`);
      const tool = factory(makeMockClient(clientOverrides));

      const result = await tool.handler(input);

      expect(result.structuredContent).toBeDefined();
      if (textIsJson) {
        expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
      }
      const parsed = tool.outputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
    });
  }

  it("covers every registered tool", () => {
    expect(new Set(Object.keys(cases))).toEqual(new Set(tools.map((t) => t.name)));
  });
});
