import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { makeMockClient, mockConnectorFetch } from "./helpers.js";

describe("createServer", () => {
  let client: Client;
  let server: McpServer;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await client?.close();
    await server?.close();
  });

  async function connectServer() {
    const mockClient = makeMockClient();
    server = createServer(mockClient, "0.1.0", "stdio", undefined, { uploads: true, email: true });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    return { client, mockClient };
  }

  describe("tools", () => {
    it("registers stdio tools with correct names", async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      expect(names).toEqual([
        "batch_create_qurls",
        "create_qurl",
        "delete_qurl",
        "extend_qurl",
        "get_qurl",
        "list_qurl_sessions",
        "list_qurls",
        "mint_link",
        "resolve_qurl",
        "revoke_qurl_token",
        "share_by_crid",
        "terminate_qurl_sessions",
        "update_qurl",
        "update_qurl_token",
        "upload_file_data_qurl",
        "upload_file_qurl",
        "upload_text_qurl",
      ]);
    });

    it("registers http tools with correct names", async () => {
      const mockClient = makeMockClient();
      server = createServer(mockClient, "0.1.0", "http", undefined, { uploads: true, email: true });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);

      client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(clientTransport);

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      expect(names).toEqual([
        "batch_create_qurls",
        "create_qurl",
        "delete_qurl",
        "extend_qurl",
        "get_qurl",
        "list_qurl_sessions",
        "list_qurls",
        "mint_link",
        "resolve_qurl",
        "revoke_qurl_token",
        "share_by_crid",
        "terminate_qurl_sessions",
        "update_qurl",
        "update_qurl_token",
        "upload_file_data_qurl",
        "upload_text_qurl",
      ]);
    });

    it("each tool has a description", async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      }
    });

    const samplePdf = resolve("src/__tests__/fixtures/sample.pdf");
    it.each([
      {
        name: "upload_file_data_qurl",
        args: {
          file_base64: readFileSync(samplePdf).toString("base64"),
          file_name: "sample.pdf",
          content_type: "application/pdf",
        },
      },
      { name: "upload_file_qurl", args: { file_path: samplePdf } },
      { name: "upload_text_qurl", args: { type: "text", content: "hello" } },
    ])(
      "$name rejects access restrictions it cannot enforce before uploading",
      async ({ name, args }) => {
        vi.stubEnv("QURL_API_KEY", "lv_live_test");
        vi.stubEnv("QURL_CONNECTOR_URL", "https://connector.test");
        const fetchMock = mockConnectorFetch();
        vi.stubGlobal("fetch", fetchMock);
        const { client } = await connectServer();

        for (const [field, value] of [
          ["access_policy", { geo_allowlist: ["US"] }],
          ["max_sessions", 3],
        ] as const) {
          const rejected = await client.callTool({ name, arguments: { ...args, [field]: value } });

          expect(rejected.isError).toBe(true);
          expect(JSON.stringify(rejected.content)).toContain(
            `${field} is not supported for uploaded files`,
          );
        }
        // Invalid durations are refused before the upload too, so a typo cannot orphan a file.
        for (const invalid of [{ expires_in: "60d" }, { session_duration: "1 hour" }]) {
          const rejected = await client.callTool({ name, arguments: { ...args, ...invalid } });
          expect(rejected.isError).toBe(true);
        }
        expect(fetchMock).not.toHaveBeenCalled();

        // Control: the same arguments without the restriction do upload.
        const accepted = await client.callTool({ name, arguments: args });
        expect(accepted.isError).not.toBe(true);
        expect(fetchMock).toHaveBeenCalled();
      },
    );

    it("advertises rejected upload options with a portable JSON Schema (no `not`)", async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();
      for (const name of ["upload_file_data_qurl", "upload_file_qurl", "upload_text_qurl"]) {
        const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
        for (const field of ["access_policy", "max_sessions"]) {
          expect(properties[field], `${name}.${field}`).toBeDefined();
          expect(JSON.stringify(properties[field]), `${name}.${field}`).not.toContain('"not"');
        }
      }
    });

    it("each tool has an input schema", async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.inputSchema, `${tool.name} missing schema`).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  describe("resources", () => {
    it("registers all 2 resources", async () => {
      const { client } = await connectServer();
      const { resources } = await client.listResources();

      expect(resources).toHaveLength(2);
    });

    it("registers resources with correct URIs", async () => {
      const { client } = await connectServer();
      const { resources } = await client.listResources();

      const uris = resources.map((r) => r.uri).sort();
      expect(uris).toEqual(["qurl://links", "qurl://usage"]);
    });
  });

  describe("prompts", () => {
    it("registers all 3 prompts", async () => {
      const { client } = await connectServer();
      const { prompts } = await client.listPrompts();

      expect(prompts).toHaveLength(3);
    });

    it("registers prompts with correct names", async () => {
      const { client } = await connectServer();
      const { prompts } = await client.listPrompts();
      const names = prompts.map((p) => p.name).sort();

      expect(names).toEqual(["audit-links", "rotate-access", "secure-a-service"]);
    });

    it("each prompt has a description", async () => {
      const { client } = await connectServer();
      const { prompts } = await client.listPrompts();

      for (const prompt of prompts) {
        expect(prompt.description, `${prompt.name} missing description`).toBeTruthy();
      }
    });
  });
});
