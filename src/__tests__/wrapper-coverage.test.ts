import { describe, it, expect, vi } from "vitest";
import { MISSING_API_KEY_MESSAGE, QURLAPIError, type IQURLClient } from "../client.js";
import { batchCreateTool } from "../tools/batch-create.js";
import { createQurlTool } from "../tools/create-qurl.js";
import { deleteQurlTool } from "../tools/delete-qurl.js";
import { extendQurlTool } from "../tools/extend-qurl.js";
import { getQurlTool } from "../tools/get-qurl.js";
import { listQurlsTool } from "../tools/list-qurls.js";
import { mintLinkTool } from "../tools/mint-link.js";
import { resolveQurlTool } from "../tools/resolve-qurl.js";
import { updateQurlTool } from "../tools/update-qurl.js";
import { linksResource } from "../resources/links.js";
import { usageResource } from "../resources/usage.js";
import { makeMockClient } from "./helpers.js";

/**
 * Parameterized smoke coverage that asserts every tool handler and every
 * resource handler is wrapped with the missing_api_key translation.
 *
 * Without this loop, dropping `withMissingApiKeyHandler` from a single
 * tool (or `withMissingApiKeyResource` from a resource) would slip past
 * unit tests — the per-handler smoke tests in create-qurl.test.ts and
 * links.test.ts only cover those two factories. The CI introspection
 * probe exercises tools/call exactly once (against list_qurls), so it
 * also wouldn't catch the regression.
 */

const missingKeyError = () =>
  new QURLAPIError(0, "missing_api_key", MISSING_API_KEY_MESSAGE);

type ToolCase = {
  name: string;
  build: (client: IQURLClient) => { handler: (input: never) => Promise<unknown> };
  // Mock methods on the client to throw missing_api_key. Keyed so each
  // tool only stubs the method it actually invokes (defensive against
  // future delegation changes — extendQURL currently delegates to
  // updateQURL, so the test stubs both).
  stubs: Array<keyof IQURLClient>;
  // Minimal valid input that satisfies the handler's schema.
  input: unknown;
};

const toolCases: ToolCase[] = [
  {
    name: "create_qurl",
    build: createQurlTool,
    stubs: ["createQURL"],
    input: { target_url: "https://example.com" },
  },
  {
    name: "resolve_qurl",
    build: resolveQurlTool,
    stubs: ["resolveQURL"],
    input: { access_token: "at_x" },
  },
  {
    name: "list_qurls",
    build: listQurlsTool,
    stubs: ["listQURLs"],
    input: {},
  },
  {
    name: "get_qurl",
    build: getQurlTool,
    stubs: ["getQURL"],
    input: { resource_id: "r_x" },
  },
  {
    name: "delete_qurl",
    build: deleteQurlTool,
    stubs: ["deleteQURL"],
    input: { resource_id: "r_x" },
  },
  {
    name: "extend_qurl",
    // extendQURL delegates to updateQURL on the client — stub both so the
    // assertion holds whether or not the delegation is preserved.
    build: extendQurlTool,
    stubs: ["extendQURL", "updateQURL"],
    input: { resource_id: "r_x", extend_by: "1h" },
  },
  {
    name: "update_qurl",
    build: updateQurlTool,
    stubs: ["updateQURL"],
    input: { resource_id: "r_x", extend_by: "1h" },
  },
  {
    name: "mint_link",
    build: mintLinkTool,
    stubs: ["mintLink"],
    input: { resource_id: "r_x" },
  },
  {
    name: "batch_create_qurls",
    build: batchCreateTool,
    stubs: ["batchCreate"],
    input: { items: [{ target_url: "https://example.com" }] },
  },
];

describe("missing_api_key wrapper coverage", () => {
  describe("every tool handler", () => {
    for (const { name, build, stubs, input } of toolCases) {
      it(`${name} returns isError content instead of throwing`, async () => {
        const overrides: Partial<IQURLClient> = {};
        for (const key of stubs) {
          (overrides as Record<string, unknown>)[key] = vi
            .fn()
            .mockRejectedValue(missingKeyError());
        }
        const client = makeMockClient(overrides);
        const tool = build(client);

        const result = (await tool.handler(input as never)) as {
          isError?: boolean;
          content: Array<{ type: string; text: string }>;
        };

        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe(MISSING_API_KEY_MESSAGE);
      });
    }
  });

  describe("every resource handler", () => {
    const resourceCases: Array<{
      name: string;
      build: (client: IQURLClient) => {
        uri: string;
        handler: () => Promise<{
          contents: Array<{ uri: string; mimeType?: string; text: string }>;
        }>;
      };
      stubs: Array<keyof IQURLClient>;
    }> = [
      { name: "qurl://links", build: linksResource, stubs: ["listQURLs"] },
      { name: "qurl://usage", build: usageResource, stubs: ["getQuota"] },
    ];

    for (const { name, build, stubs } of resourceCases) {
      it(`${name} returns error JSON content instead of throwing`, async () => {
        const overrides: Partial<IQURLClient> = {};
        for (const key of stubs) {
          (overrides as Record<string, unknown>)[key] = vi
            .fn()
            .mockRejectedValue(missingKeyError());
        }
        const client = makeMockClient(overrides);
        const resource = build(client);

        const result = await resource.handler();

        expect(result.contents).toHaveLength(1);
        expect(result.contents[0].uri).toBe(resource.uri);
        const body = JSON.parse(result.contents[0].text) as {
          error?: { code?: string; message?: string };
        };
        expect(body.error?.code).toBe("missing_api_key");
        expect(body.error?.message).toBe(MISSING_API_KEY_MESSAGE);
      });
    }
  });
});
