import { describe, it, expect } from "vitest";
import { toolFactories } from "../server.js";
import { deleteQurlTool } from "../tools/delete-qurl.js";
import { makeMockClient } from "./helpers.js";

const tools = toolFactories.map((factory) => factory(makeMockClient()));

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
    });
  }

  describe("safety hints match tool semantics", () => {
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
      const tool = deleteQurlTool(makeMockClient());
      expect(tool.annotations.destructiveHint).toBe(true);
    });
  });
});
