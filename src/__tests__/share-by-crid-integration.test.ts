import { createServer as createHTTPServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { QURLClient } from "../client.js";
import { createServer } from "../server.js";
import { sampleShareCRIDOutput } from "./helpers.js";

// Exercise the registered tool, real client HTTP request, and MCP output
// validation together; unit mocks cannot detect drift between these layers.
describe.each(["stdio", "http"] as const)("share_by_crid in %s mode", (mode) => {
  it("shares a marked CRID and accepts older resources without a CRID", async () => {
    const requests: { path?: string; body: string; authorization?: string }[] = [];
    const payload = { ...sampleShareCRIDOutput(), future_api_field: "preserved" };
    const legacyPayload = { ...payload, crid: undefined };
    const api = createHTTPServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, body, authorization: req.headers.authorization });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: requests.length === 1 ? payload : legacyPayload }));
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("No HTTP port");
    const server = createServer(
      new QURLClient({ apiKey: "test-key", baseURL: `http://127.0.0.1:${address.port}` }),
      "test",
      mode,
    );
    const client = new Client({ name: "share-integration", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "share_by_crid",
        arguments: { crid: "$crid_test", ttl: "1.001s999ms" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(payload);
      const legacy = await client.callTool({
        name: "share_by_crid",
        arguments: { crid: "resource-public-key" },
      });
      expect(legacy.isError).not.toBe(true);
      expect(legacy.structuredContent).toEqual(legacyPayload);
      expect(requests).toEqual([
        {
          path: "/v1/resources/crid_test/share",
          body: '{"ttl_seconds":2}',
          authorization: "Bearer test-key",
        },
        {
          path: "/v1/resources/resource-public-key/share",
          body: "{}",
          authorization: "Bearer test-key",
        },
      ]);
    } finally {
      await client.close();
      await server.close();
      api.close();
      await once(api, "close");
    }
  });
});
