import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { defineToolFactory } from "../server.js";
import { makeMockClient } from "./helpers.js";

const metadata = {
  name: "fixture",
  title: "Fixture",
  description: "Registry fixture",
  outputSchema: z.object({}),
  annotations: { readOnlyHint: true },
};
const result = { content: [{ type: "text" as const, text: "ok" }] };

describe("typed tool registration", () => {
  it("infers object input and validates the erased boundary", async () => {
    const called = vi.fn();
    const factory = defineToolFactory(() => ({
      ...metadata,
      inputSchema: z.object({ count: z.number() }),
      handler: async (input) => {
        expectTypeOf(input.count).toEqualTypeOf<number>();
        called(input.count);
        return result;
      },
    }));
    const tool = factory(makeMockClient(), { mode: "stdio" });
    expect(await tool.handler({ count: 3 })).toEqual(result);
    expect(called).toHaveBeenCalledExactlyOnceWith(3);
    expect(await tool.handler({ count: "3" })).toMatchObject({ isError: true });
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("accepts zero-argument handlers", async () => {
    const factory = defineToolFactory(() => ({
      ...metadata,
      inputSchema: z.object({}),
      handler: async () => result,
    }));
    expect(await factory(makeMockClient(), { mode: "stdio" }).handler({})).toEqual(result);
  });
});

// This declaration is compiled by typecheck:tests but never registered or called.
defineToolFactory(() => ({
  ...metadata,
  inputSchema: z.object({ count: z.number() }),
  // @ts-expect-error A string handler must not match a numeric input schema.
  handler: async (_input: { count: string }) => result,
}));
