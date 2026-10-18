import { describe, expect, it, vi } from "vitest";

const script = new URL("../../scripts/wait-for-npm-release.mjs", import.meta.url).href;
const { waitForNpmRelease } = await import(script);
const name = "@layervai/qurl-mcp";
const version = "0.7.1";
const ready = () => new Response(JSON.stringify({ name, version }));

describe("npm release readiness", () => {
  it("waits for transient 404 and verifies the exact public package", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(ready());
    const pause = vi.fn();
    await waitForNpmRelease(name, version, { request, pause });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/%40layervai%2Fqurl-mcp/0.7.1",
    );
    expect(pause).toHaveBeenCalledWith(10_000);
  });

  it.each([401, 403, 429, 500])("does not retry HTTP %s as publication lag", async (status) => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status }));
    const pause = vi.fn();
    await expect(waitForNpmRelease(name, version, { request, pause })).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it.each([
    { name: "other", version },
    { name, version: "0.7.0" },
  ])("rejects mismatched metadata", async (metadata) => {
    await expect(
      waitForNpmRelease(name, version, {
        request: async () => new Response(JSON.stringify(metadata)),
      }),
    ).rejects.toThrow("different package or version");
  });

  it("stops after the bounded 404 budget", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const pause = vi.fn();
    await expect(waitForNpmRelease(name, version, { request, pause, attempts: 3 })).rejects.toThrow(
      "did not become available",
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed metadata", async () => {
    await expect(
      waitForNpmRelease(name, version, { request: async () => new Response("not JSON") }),
    ).rejects.toThrow();
  });

  it("fails on a transport error", async () => {
    const request = vi.fn().mockRejectedValue(new Error("DNS failure"));
    await expect(waitForNpmRelease(name, version, { request })).rejects.toThrow("DNS failure");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
