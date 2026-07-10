import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ServerManifest = {
  packages: Array<{ environmentVariables?: Array<{ name: string; default?: string }> }>;
};

describe("published stdio environment manifests", () => {
  const serverManifest = JSON.parse(readFileSync("server.json", "utf8")) as ServerManifest;
  const smitheryManifest = readFileSync("smithery.yaml", "utf8");
  const runtimeConfigSource = readFileSync("src/config.ts", "utf8");
  const publishedVariables = serverManifest.packages[0]?.environmentVariables ?? [];

  it("keeps every server.json variable in the Smithery command mapping", () => {
    for (const variable of publishedVariables) {
      expect(smitheryManifest).toContain(`${variable.name}:`);
    }
  });

  it("keeps HTTP-only listener variables out of stdio manifests", () => {
    const names = publishedVariables.map((variable) => variable.name);
    expect(names).not.toContain("QURL_MCP_HTTP_CONFIG");
    expect(names).not.toContain("MCP_MAX_SESSIONS");
    expect(names).not.toContain("MCP_TRUST_PROXY_HOPS");
  });

  it("keeps the production API default identical in every published fallback", () => {
    const smitherySchemaDefault = /qurlApiUrl:[\s\S]{0,400}?default:\s*(https?:\/\/\S+)/.exec(
      smitheryManifest,
    )?.[1];
    const smitheryCommandDefault = /QURL_API_URL:\s*config\.qurlApiUrl\s*\|\|\s*'([^']+)'/.exec(
      smitheryManifest,
    )?.[1];
    const serverDefault = publishedVariables.find(
      (variable) => variable.name === "QURL_API_URL",
    )?.default;
    const runtimeDefault = /fileConfig\.defaultQurlApiUrl\s*\|\|\s*"([^"]+)"/.exec(
      runtimeConfigSource,
    )?.[1];

    expect([smitherySchemaDefault, smitheryCommandDefault, serverDefault, runtimeDefault]).toEqual(
      Array(4).fill("https://api.layerv.ai"),
    );
  });
});
