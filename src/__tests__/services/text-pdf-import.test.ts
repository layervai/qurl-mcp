import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("text PDF module initialization", () => {
  it("does not inspect or warn about the bundled font during ESM evaluation", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({ ...actualFs, existsSync: () => false }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await import("../../services/text-pdf.js");

    expect(warn).not.toHaveBeenCalled();
  });
});
