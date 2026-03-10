import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { makeMockClient } from "./helpers.js";

describe("createServer", () => {
  let client: Client;
  let server: McpServer;

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  async function connectServer() {
    const mockClient = makeMockClient();
    server = createServer(mockClient, "0.1.0");

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    return { client, mockClient };
  }

  describe("tools", () => {
    it("registers all 6 tools", async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      expect(tools).toHaveLength(6);
    });

    it("registers tools with correct names", async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      expect(names).toEqual([
        "create_qurl",
        "delete_qurl",
        "extend_qurl",
        "get_qurl",
        "list_qurls",
        "resolve_qurl",
      ]);
    });

    it("each tool has a description", async () => {
      const { client } = await connectServer();
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.description, `${tool.name} missing description`).toBeTruthy();
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
