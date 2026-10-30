import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { toolScopeOptions, requiredToolScopes } from "../../auth/hosted-oauth.js";
import { toolFactories } from "../../server.js";
import { makeMockClient } from "../helpers.js";

it("covers every API tool with the documented scope contract", () => {
  // Keep CLAUDE.md's tool scope column aligned with the executable policy.
  const source = readFileSync(new URL("../../../CLAUDE.md", import.meta.url), "utf8");
  for (const factory of toolFactories) {
    const tool = factory(makeMockClient(), { mode: "http" });
    const row = source.split("\n").find((line) => line.startsWith(`| \`${tool.name}\``));
    expect(row, tool.name).toBeDefined();
    const documented = row!.split("|")[2].match(/qurl:[a-z]+/g) ?? [];
    expect([...new Set(toolScopeOptions(tool.name).flat())].sort(), tool.name).toEqual(
      [...new Set(documented)].sort(),
    );
  }
  expect(() => toolScopeOptions("future_unmapped_tool")).toThrow("Missing OAuth scope policy");
});

it("uses the access action to request only the permission it needs", () => {
  for (const action of ["list_invitations", "list_grants"]) {
    expect(requiredToolScopes("manage_crid_access", { action })).toEqual(["qurl:read"]);
  }
  for (const action of [
    "invite",
    "configure",
    "resend",
    "revoke_invitation",
    "approve",
    "deny",
    "revoke_grant",
  ]) {
    expect(requiredToolScopes("manage_crid_access", { action })).toEqual(["qurl:write"]);
  }
  expect(requiredToolScopes("extend_qurl", {})).toEqual(["qurl:write", "qurl:read"]);
});
