import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWithRequestAuthContext } from "../../auth/request-context.js";
import { clearRuntimeConfigCache } from "../../config.js";
import { mintUploadedFileLinkTool } from "../../tools/mint-uploaded-file-link.js";
import { connectorMintedLink, makeMockClient, mockConnectorFetch } from "../helpers.js";

beforeEach(() => {
  vi.stubEnv("QURL_API_KEY", "lv_server_key");
  vi.stubEnv("QURL_CONNECTOR_URL", "https://connector.test");
  vi.stubEnv("QURL_LINK_HOSTS", "qurl.link");
  vi.stubEnv("QURL_MCP_CONFIG", join(tmpdir(), randomUUID() + ".json"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearRuntimeConfigCache();
});

it("uses the HTTP caller credential and marks it validated only after minting", async () => {
  const fetch = mockConnectorFetch();
  vi.stubGlobal("fetch", fetch);
  const validated = vi.fn();
  const client = makeMockClient();
  const tool = mintUploadedFileLinkTool(client, { mode: "http" });
  const result = await runWithRequestAuthContext(
    { qurlApiKey: "lv_caller_key", markCredentialValidated: validated },
    () => tool.handler({ resource_id: "r_upload12345" }),
  );
  expect(result.isError).not.toBe(true);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://connector.test/api/mint_link/r_upload12345",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer lv_caller_key" }),
      redirect: "error",
    }),
  );
  expect(validated).toHaveBeenCalledOnce();
  expect(client.mintLink).not.toHaveBeenCalled();
});

it("does not use the server key for an unauthenticated HTTP caller", async () => {
  const fetch = mockConnectorFetch();
  vi.stubGlobal("fetch", fetch);
  const result = await mintUploadedFileLinkTool(makeMockClient(), { mode: "http" }).handler({
    resource_id: "r_upload12345",
  });
  expect(result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { resource_id: "../other" },
  { resource_id: "q_123456789ab" },
  { resource_id: "https://other.example/file" },
  { expires_in: "31d" },
  { session_duration: "1500ms" },
])("rejects invalid mint arguments before a request: %j", async (input) => {
  const fetch = mockConnectorFetch();
  vi.stubGlobal("fetch", fetch);
  const result = await mintUploadedFileLinkTool(makeMockClient(), { mode: "stdio" }).handler({
    resource_id: "r_upload12345",
    ...input,
  });
  expect(result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it("makes one attempt and preserves uncertain-outcome guidance after a server failure", async () => {
  const fetch = mockConnectorFetch(undefined, () =>
    Response.json({ error: "private-upstream-detail" }, { status: 502 }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await mintUploadedFileLinkTool(makeMockClient(), { mode: "stdio" }).handler({
    resource_id: "r_upload12345",
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  expect(text).toContain("r_upload12345");
  expect(text).toContain("a link may already have been minted");
  expect(text).not.toContain("private-upstream-detail");
  expect(text).not.toContain("Upload succeeded");
  expect(text).toContain("Tell the user and ask before minting a replacement");
  expect(text).not.toContain("use mint_uploaded_file_link");
});

it("applies the host policy to a replacement link", async () => {
  const fetch = mockConnectorFetch(undefined, (body) =>
    Response.json({
      success: true,
      links: [
        {
          ...connectorMintedLink,
          qurl_link: "https://evil.example/#at_fixture",
          expires_at: body.expires_at,
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await mintUploadedFileLinkTool(makeMockClient(), { mode: "stdio" }).handler({
    resource_id: "r_upload12345",
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("not permitted by QURL_LINK_HOSTS/linkHosts");
  expect(result.content[0].text).not.toContain("evil.example");
});
