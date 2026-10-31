import { Buffer } from "node:buffer";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigCache } from "../config.js";
import { createServer } from "../server.js";
import { makeMockClient } from "./helpers.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearRuntimeConfigCache();
});

it("recovers a failed mint through the official client without uploading another file", async () => {
  let uploads = 0;
  let mints = 0;
  const mintBodies: unknown[] = [];
  const authorization: Array<string | undefined> = [];
  const connector = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    authorization.push(request.headers.authorization);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/upload") {
      uploads++;
      response.end(JSON.stringify({ resource_id: "r_upload12345" }));
    } else if (request.url === "/api/mint_link/r_upload12345") {
      mints++;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      mintBodies.push(body);
      if (mints === 1) {
        response.statusCode = 502;
        response.end(JSON.stringify({ error: "not minted" }));
      } else {
        response.end(
          JSON.stringify({
            success: true,
            links: [
              {
                qurl_id: "q_123456789ab",
                qurl_link: "https://qurl.link/#at_recovered",
                expires_at: body.expires_at,
              },
            ],
          }),
        );
      }
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => connector.listen(0, "127.0.0.1", resolve));
  close.push(
    () =>
      new Promise<void>((resolve, reject) =>
        connector.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = connector.address();
  if (!address || typeof address === "string") throw new Error("missing loopback listener");
  vi.stubEnv("QURL_API_KEY", "lv_test_recovery");
  vi.stubEnv("QURL_CONNECTOR_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("QURL_LINK_HOSTS", "qurl.link");
  vi.stubEnv("QURL_MCP_CONFIG", join(tmpdir(), randomUUID() + ".json"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const api = makeMockClient();
  const server = createServer(api, "test", "stdio", undefined, { uploads: true, email: false });
  const client = new Client({ name: "mint-recovery-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  close.push(
    () => server.close(),
    () => client.close(),
  );
  const { tools } = await client.listTools();
  const first = await client.callTool({
    name: "upload_file_data_qurl",
    arguments: {
      file_base64: readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)).toString(
        "base64",
      ),
      file_name: "sample.pdf",
      content_type: "application/pdf",
    },
  });
  expect(first.isError).toBe(true);
  expect(uploads).toBe(1);
  expect(mints).toBe(1);
  expect(tools.map((tool) => tool.name)).toContain("mint_uploaded_file_link");
  const recovered = await client.callTool({
    name: "mint_uploaded_file_link",
    arguments: {
      resource_id: "r_upload12345",
      expires_in: "2h",
      one_time_use: true,
      session_duration: "10m",
    },
  });
  expect(recovered.isError).not.toBe(true);
  expect(recovered.structuredContent).toMatchObject({
    resource_id: "r_upload12345",
    qurl_link: "https://qurl.link/#at_recovered",
  });
  expect(recovered.structuredContent).not.toHaveProperty("file_name");
  expect(uploads).toBe(1);
  expect(mints).toBe(2);
  expect(authorization).toEqual(Array(3).fill("Bearer lv_test_recovery"));
  expect(mintBodies[1]).toMatchObject({ n: 1, one_time_use: true, session_duration: "600s" });
  expect(api.mintLink).not.toHaveBeenCalled();
});
