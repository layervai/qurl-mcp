import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      list_qurls: ["get_qurl", "resolve_qurl"],
      create_qurl: ["mint_link", "batch_create_qurls", "update_qurl"],
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

  describe("Returns block keys exist in outputSchema", () => {
    // The TDQS template includes a `**Returns:** \`{ ... }\`` block listing
    // the response shape. An out-of-date Returns block tells an LLM agent
    // to plan against fields that don't exist (or omits real ones), which
    // is exactly the disambiguation rot the rewrite is trying to prevent.
    // Lock it down by parsing the *top-level* keys from the block and
    // asserting each appears in the tool's outputSchema.shape. Nested
    // shapes (e.g. `meta: { has_more, … }`) are out of scope for this
    // structural check — and not caught by the round-trip test below
    // either, which validates the handler's structuredContent against
    // outputSchema (handler ↔ schema), not the description's nested
    // claims against the schema. A future test could close that gap;
    // top-level coverage is the bigger lever for now.
    //
    // **One-directional by design.** This enforces description ⊆ schema:
    // a key claimed in the description must exist in the schema. It does
    // *not* enforce the inverse (every schema key must be documented).
    // Adding a schema field without updating the description will pass
    // this test silently — that's intentional, since not every field is
    // worth surfacing in the description, but flagging so a future
    // reader doesn't assume bidirectional coverage.
    //
    // **Bare keys only.** The walker matches identifier-followed-by-colon
    // at depth 0. A future Returns block that wraps keys in backticks or
    // quotes (e.g. `` `success`: literal `true` ``) will skip them
    // silently — adapt the walker if/when that pattern shows up.
    //
    // Tools without a Returns block (or whose block describes a
    // discriminated/wrapped shape) are skipped here.
    const topLevelKeys = (body: string): string[] => {
      const keys: string[] = [];
      // Sticky regex: anchored to lastIndex, so we walk `body` without
      // re-slicing on every iteration.
      const keyRe = /([a-zA-Z_]\w*)\??\s*:/y;
      let depth = 0;
      // Skip everything inside a quoted/backticked literal so a prose
      // colon (e.g. `string ("RFC 3339: timestamps")`) doesn't capture
      // the preceding word as a fake key. Tracks the active opener; null
      // means we're not in a string. Backticks are treated as flat
      // strings — Returns blocks today don't carry template-literal
      // `${…}` interpolations, and any future block that does will need
      // an interpolation-aware extension to this walker.
      let inString: '"' | "'" | "`" | null = null;
      let i = 0;
      while (i < body.length) {
        const ch = body[i];
        if (inString !== null) {
          if (ch === "\\") {
            // Skip the escaped char so an escaped quote doesn't end the
            // literal. Guard against a trailing backslash so `i += 2`
            // doesn't overshoot — exit cleanly instead.
            if (i + 1 >= body.length) break;
            i += 2;
            continue;
          }
          if (ch === inString) inString = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inString = ch;
          i++;
          continue;
        }
        if (ch === "{") {
          depth++;
          i++;
          continue;
        }
        if (ch === "}") {
          // Clamp at zero. Returns blocks should be balanced, but a
          // malformed input shouldn't make `depth` go negative and
          // accidentally re-enter the depth-0 capture branch.
          depth = Math.max(0, depth - 1);
          i++;
          continue;
        }
        if (depth === 0) {
          keyRe.lastIndex = i;
          const m = keyRe.exec(body);
          if (m) {
            keys.push(m[1]);
            i = keyRe.lastIndex;
            continue;
          }
        }
        i++;
      }
      return keys;
    };
    // Find `**Returns:** \`{ ... }\`` and return the body between the
    // outermost balanced braces. A non-greedy regex would truncate at
    // the first `}` (e.g. inside `meta: { … }`) and silently miss any
    // top-level keys that follow the nested object — this walker
    // returns the full balanced body so topLevelKeys sees them all.
    const extractReturnsBody = (description: string): string | null => {
      const marker = description.match(/\*\*Returns:\*\*\s*`\{/);
      if (!marker || marker.index === undefined) return null;
      const open = marker.index + marker[0].length - 1;
      let depth = 0;
      for (let i = open; i < description.length; i++) {
        if (description[i] === "{") depth++;
        else if (description[i] === "}") {
          depth--;
          if (depth === 0) return description.slice(open + 1, i);
        }
      }
      return null;
    };
    for (const tool of tools) {
      const body = extractReturnsBody(tool.description);
      if (body === null) continue;
      it(`${tool.name} Returns block claims only keys present in schema`, () => {
        const claimed = topLevelKeys(body);
        expect(claimed.length, `${tool.name} Returns block parsed zero keys`).toBeGreaterThan(0);
        const schemaKeys = new Set(Object.keys(tool.outputSchema.shape));
        for (const key of claimed) {
          expect(schemaKeys, `Returns block claims '${key}' but it isn't in ${tool.name}'s outputSchema`).toContain(key);
        }
      });
    }
  });

  describe("schema describe() and tool description stay aligned", () => {
    // Defense-in-depth: some hosts surface the schema-level `.describe()`
    // in argument hints without rendering the tool's overall description.
    // When a strong factual claim (like "default to active") lives in
    // both, lock both to a shared substring so a future copy edit can't
    // drift one without the other.
    it("list_qurls.status default-active claim appears in both .describe() and the tool description", async () => {
      const { listQurlsSchema } = await import("../tools/list-qurls.js");
      const description = tools.find((t) => t.name === "list_qurls")!.description;
      const statusFieldDescription = listQurlsSchema.shape.status.description ?? "";
      // Sentinels must uniquely encode the *default-active claim*, not just
      // mention the word `active` (which appears in unrelated contexts: the
      // example block, the "everything still active" prose, the comma-
      // separated enum). Without a claim-specific phrase, the test would
      // silently pass if both sides dropped the default claim entirely.
      expect(
        statusFieldDescription,
        "list_qurls.status .describe() must assert the active default with the phrase \"Defaults to 'active'\"",
      ).toContain("Defaults to 'active'");
      expect(
        description,
        "list_qurls description must assert the active default with the phrase \"By default only `active`\"",
      ).toContain("By default only `active`");
    });
  });

  describe("description claims pinned against api-spec defaults", () => {
    // Strong factual claims about API defaults (e.g. "expires_in defaults
    // to 24h") become silent lies if the server-side default moves. Read
    // the snapshot at api-spec/qurls.yaml — the same file the spec-drift
    // workflow already monitors — and assert the description quotes the
    // value verbatim. If the spec changes, the drift workflow updates the
    // file and this test forces a description update at the same time.
    const specPath = fileURLToPath(new URL("../../api-spec/qurls.yaml", import.meta.url));
    const spec = readFileSync(specPath, "utf8");

    it("create_qurl description matches the spec's expires_in default", () => {
      // The spec has two `expires_in: type: string` blocks (CreateQurlRequest
      // and MintLinkRequest) — only the create-side declares a `Default:`
      // inside its own description (MintLink puts the 24h default in the
      // parent schema description, not the property's). Iterate every match
      // and pick the block that carries `Default:`; relying on source
      // order would silently pick the wrong block if the schemas ever
      // swap positions.
      //
      // Indent matcher is `[ ]{12,}` (description-body depth) rather than
      // `\s+` so the captured block stops at the next outdented line —
      // sibling property values (`example:`) sit at 10 spaces, sibling
      // properties (`one_time_use:`) at 8 — both correctly excluded.
      const blocks = [
        ...spec.matchAll(
          /expires_in:\s*\n\s*type:\s*string\s*\n\s*description:\s*\|\s*\n((?:[ ]{12,}[^\n]+\n)+)/g,
        ),
      ];
      expect(
        blocks.length,
        "no `expires_in:` block in api-spec/qurls.yaml matched the structural pattern " +
          "(`type: string` immediately, then `description: |`). If the spec was reordered, " +
          "added `nullable:`, switched to a quoted scalar, or moved to a $ref, loosen the regex to match.",
      ).toBeGreaterThan(0);
      const blockWithDefault = blocks.find((m) => /Default:\s*\d+\s*[a-z]+/.test(m[1]));
      expect(
        blockWithDefault,
        "no expires_in description block in api-spec/qurls.yaml carries a `Default: …` line",
      ).toBeDefined();
      const specDefault = blockWithDefault![1].match(/Default:\s*(\d+\s*[a-z]+)/)![1].trim();
      const description = tools.find((t) => t.name === "create_qurl")!.description;
      // Require the bolded form (`**24h**`) used in the Behavior beat,
      // not just the unbolded literal. Bare `24h` also appears in the
      // `Example:` line, so plain .toContain would silently pass if the
      // spec moved to e.g. 48h while the example still read '24h'.
      const claim = `**${specDefault}**`;
      expect(
        description,
        `create_qurl Behavior beat must mention the spec's expires_in default as '${claim}'`,
      ).toContain(claim);
    });
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
