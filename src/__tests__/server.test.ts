import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { makeMockClient } from "./helpers.js";

describe("createServer", () => {
  let client: Client;

  afterEach(async () => {
    await client?.close();
  });

  async function connectServer() {
    const mockClient = makeMockClient();
    const server = createServer(mockClient);

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

    it("registers resources with correct URIs and names", async () => {
      const { client } = await connectServer();
      const { resources } = await client.listResources();

      // McpServer.resource(name, uri, handler) — name is the identifier
      const byName = new Map(resources.map((r) => [r.name, r.uri]));
      expect(byName.has("qurl://links")).toBe(true);
      expect(byName.has("qurl://usage")).toBe(true);
    });
  });
});
