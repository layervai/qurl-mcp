import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { toolScopes } from "../../auth/hosted-oauth.js";
import { toolFactories } from "../../server.js";
import { listCridAccessTool } from "../../tools/consumer-access.js";
import { makeMockClient } from "../helpers.js";

it("covers every API tool with the documented scope contract", () => {
  // Keep CLAUDE.md's tool scope column aligned with the executable policy.
  const source = readFileSync(new URL("../../../CLAUDE.md", import.meta.url), "utf8");
  for (const factory of [...toolFactories, listCridAccessTool]) {
    const tool = factory(makeMockClient(), { mode: "http" });
    const row = source.split("\n").find((line) => line.startsWith(`| \`${tool.name}\``));
    expect(row, tool.name).toBeDefined();
    const documented = row!.split("|")[2].match(/qurl:[a-z]+/g) ?? [];
    expect([...new Set(toolScopes(tool.name))].sort(), tool.name).toEqual(
      [...new Set(documented)].sort(),
    );
  }
  expect(toolScopes("extend_qurl")).toEqual(["qurl:write", "qurl:read"]);
  expect(() => toolScopes("future_unmapped_tool")).toThrow("Missing OAuth scope policy");
});
