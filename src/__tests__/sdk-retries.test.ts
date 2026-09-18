import { afterEach, describe, expect, it, vi } from "vitest";
import { QURLClient } from "../client.js";
import { createQurlTool } from "../tools/create-qurl.js";
import { sampleCreateQURLData } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("create_qurl SDK retry contract", () => {
  it.each(["network", "rate-limit"])("reuses the POST key after a %s failure", async (failure) => {
    vi.useFakeTimers();
    const data = sampleCreateQURLData();
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (failure === "network") {
      fetch.mockRejectedValueOnce(new TypeError("connection lost"));
    } else {
      fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ title: "Too Many Requests", status: 429 }), {
          status: 429,
          headers: { "Content-Type": "application/problem+json", "Retry-After": "1" },
        }),
      );
    }
    fetch.mockImplementation(async () => Response.json({ data }));
    vi.stubGlobal("fetch", fetch);
    const tool = createQurlTool(
      new QURLClient({ apiKey: "lv_live_test", baseURL: "https://api.example.com" }),
      { mode: "http" },
    );
    const input = { target_url: "https://example.com/private" };

    const firstCall = tool.handler(input);
    await vi.runAllTimersAsync();
    expect((await firstCall).structuredContent).toMatchObject(data);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = fetch.mock.calls[0][1]!;
    const retry = fetch.mock.calls[1][1]!;
    const key = new globalThis.Headers(first.headers).get("Idempotency-Key");
    expect(first.method).toBe("POST");
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(new globalThis.Headers(retry.headers).get("Idempotency-Key")).toBe(key);
    expect(retry.body).toBe(first.body);

    // A new tools/call is a new mutation, not an SDK transport retry.
    await tool.handler(input);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new globalThis.Headers(fetch.mock.calls[2][1]!.headers).get("Idempotency-Key")).not.toBe(key);
  });
});
