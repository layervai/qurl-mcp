import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { QURL_CLI_MISSING_MESSAGE, QurlCli, type IQurlCli } from "../qurl-cli.js";
import { createLocalCliServer } from "../server.js";
import { makeFakeQurl, SAMPLE_CRID, type FakeQurl } from "./fake-qurl.js";

describe("createLocalCliServer", () => {
  let client: Client | undefined;
  let server: McpServer | undefined;
  let fake: FakeQurl | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    fake?.cleanup();
    client = server = fake = undefined;
  });

  async function connect(cli: IQurlCli): Promise<Client> {
    server = createLocalCliServer(cli, "0.0.0-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("lists only the tools that work through the local CLI", async () => {
    const mcp = await connect(new QurlCli({ env: { PATH: "" }, fallbackDirs: [] }));

    const { tools } = await mcp.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "delete_crid",
      "list_crids",
      "manage_crid_access",
      "manage_crid_requests",
      "publish_crid",
      "set_crid_sharing",
      "share_by_crid",
    ]);
    expect(mcp.getServerCapabilities()?.resources).toBeUndefined();
    expect(mcp.getServerCapabilities()?.prompts).toBeUndefined();
  });

  it("answers a tool call with the install instruction when the CLI is missing", async () => {
    const mcp = await connect(new QurlCli({ env: { PATH: "" }, fallbackDirs: [] }));

    const result = await mcp.callTool({ name: "list_crids", arguments: {} });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: QURL_CLI_MISSING_MESSAGE }],
    });
  });

  it("publishes a local app end to end through the fake CLI", async () => {
    fake = makeFakeQurl();
    const mcp = await connect(
      fake.cli({
        stdout: {
          private: true,
          crid: SAMPLE_CRID,
          resource_id: "pubkey",
          target_url: "http://localhost:5173",
          status: "serving",
          found_existing: false,
          publisher: { verified: false },
        },
      }),
    );

    const result = await mcp.callTool({
      name: "publish_crid",
      arguments: { target_url: "http://localhost:5173" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ crid: SAMPLE_CRID, private: true });
    expect(fake.calls().map((entry) => entry.argv)).toEqual([
      ["publish", "http://localhost:5173", "--output=json"],
    ]);
  });

  it("refuses approval without a code at the protocol boundary", async () => {
    fake = makeFakeQurl();
    const mcp = await connect(fake.cli());

    const result = await mcp.callTool({
      name: "manage_crid_requests",
      arguments: { action: "approve", crid: SAMPLE_CRID },
    });

    expect(result.isError).toBe(true);
    expect(fake.calls()).toEqual([]);
  });
});
