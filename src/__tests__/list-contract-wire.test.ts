import { afterEach, describe, expect, it, vi } from "vitest";
import { QURLClient } from "../client.js";
import { listQurlsSchema, listQurlsTool } from "../tools/list-qurls.js";
import { sampleQURL } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("list contract through the installed SDK", () => {
  it("omits status on the wire and keeps both returned resource statuses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        data: [sampleQURL({ status: "active" }), sampleQURL({ status: "revoked" })],
        meta: { has_more: false },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new QURLClient({ apiKey: "test-key", baseURL: "https://api.example.com" });
    const result = await listQurlsTool(client).handler(listQurlsSchema.parse({}));
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = String(fetch.mock.calls[0]?.[0]);
    expect(new URL(request).pathname).toBe("/v1/qurls");
    expect(new URL(request).searchParams.has("status")).toBe(false);
    const output = JSON.parse(result.content[0].text);
    expect(output.data.map((resource: { status: string }) => resource.status)).toEqual([
      "active",
      "revoked",
    ]);
  });

  it("forwards combined filters and an explicit sort in one request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ data: [], meta: { has_more: false } }));
    vi.stubGlobal("fetch", fetch);
    const client = new QURLClient({ apiKey: "test-key", baseURL: "https://api.example.com" });
    await listQurlsTool(client).handler(
      listQurlsSchema.parse({
        status: "active",
        created_after: "2026-01-01T00:00:00Z",
        sort: "expires_at:asc",
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const query = new URL(String(fetch.mock.calls[0]?.[0])).searchParams;
    expect(query.get("status")).toBe("active");
    expect(query.get("created_after")).toBe("2026-01-01T00:00:00Z");
    expect(query.get("sort")).toBe("expires_at:asc");
  });
});
