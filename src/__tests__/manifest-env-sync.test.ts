import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ServerManifest = {
  packages: Array<{ environmentVariables?: Array<{ name: string; default?: string }> }>;
};

describe("published stdio environment manifests", () => {
  const serverManifest = JSON.parse(readFileSync("server.json", "utf8")) as ServerManifest;
  const smitheryManifest = readFileSync("smithery.yaml", "utf8");
  const runtimeConfigSource = readFileSync("src/config.ts", "utf8");
  const claudeGuidance = readFileSync("CLAUDE.md", "utf8");
  const bugReportTemplate = readFileSync(".github/ISSUE_TEMPLATE/bug_report.yml", "utf8");
  const gitignore = readFileSync(".gitignore", "utf8");
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
    const runtimeDefault = /DEFAULT_QURL_API_URL\s*=\s*"([^"]+)"/.exec(runtimeConfigSource)?.[1];

    expect([smitherySchemaDefault, smitheryCommandDefault, serverDefault, runtimeDefault]).toEqual(
      Array(4).fill("https://api.layerv.ai"),
    );
    expect(runtimeConfigSource).toContain("fileConfig.defaultQurlApiUrl || DEFAULT_QURL_API_URL");
  });

  it("keeps documented commit scopes aligned with the bug-report component list", () => {
    const scopeSection = claudeGuidance.split("### Scopes")[1]?.split("## API Spec Maintenance")[0];
    const componentSection = bugReportTemplate
      .split("    id: component")[1]
      ?.split("    validations:")[0];
    if (!scopeSection || !componentSection) throw new Error("Expected scope guidance sections");

    const documentedScopes = [...scopeSection.matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1]);
    const componentOptions = [...componentSection.matchAll(/^\s+- ([a-z]+)$/gm)]
      .map((match) => match[1])
      .filter((scope) => scope !== "other");

    expect(documentedScopes).toEqual(componentOptions);
  });

  it("keeps Claude guidance current for upload tools and configuration families", () => {
    for (const tool of ["upload_file_qurl", "upload_file_data_qurl", "upload_text_qurl"]) {
      expect(claudeGuidance).toContain(`| \`${tool}\``);
    }
    for (const variable of [
      "QURL_CONNECTOR_URL",
      "MCP_MAX_UPLOAD_FILE_DATA_BYTES",
      "QURL_SMTP_*",
      "QURL_PUBLIC_VIDEO_*",
    ]) {
      expect(claudeGuidance).toContain(`\`${variable}\``);
    }
  });

  it("ignores operator-named config copies without hiding tracked examples", () => {
    for (const stem of ["qurl-mcp.config", "qurl-mcp.http"]) {
      expect(gitignore).toContain(`${stem}.*.json`);
      expect(gitignore).toContain(`!${stem}.example.json`);
    }
  });
});
