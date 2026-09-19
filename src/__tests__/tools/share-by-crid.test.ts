import { describe, expect, it, vi } from "vitest";
import { shareByCRIDTool } from "../../tools/share-by-crid.js";
import { makeMockClient, sampleShareCRIDOutput } from "../helpers.js";

describe("shareByCRIDTool", () => {
  it("passes the CRID to the client and returns the link payload", async () => {
    const shareByCRID = vi.fn().mockResolvedValue({ data: sampleShareCRIDOutput() });
    const tool = shareByCRIDTool(makeMockClient({ shareByCRID }));

    const result = await tool.handler({ crid: "crid_test" });

    expect(shareByCRID).toHaveBeenCalledWith("crid_test", undefined);
    expect(result.structuredContent).toEqual(sampleShareCRIDOutput());
    expect(JSON.parse(result.content[0].text)).toEqual(sampleShareCRIDOutput());
  });

  it('recognizes the user-facing "$<CRID>" form and strips the prefix', async () => {
    const shareByCRID = vi.fn().mockResolvedValue({ data: sampleShareCRIDOutput() });
    const tool = shareByCRIDTool(makeMockClient({ shareByCRID }));

    await tool.handler({ crid: "$crid_test" });

    expect(shareByCRID).toHaveBeenCalledWith("crid_test", undefined);
    expect(tool.description).toContain("leading `$` marker");
  });

  it('rejects a "$" marker without a CRID', async () => {
    const shareByCRID = vi.fn();
    const tool = shareByCRIDTool(makeMockClient({ shareByCRID }));

    const result = await tool.handler({ crid: "$" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must contain a value");
    expect(shareByCRID).not.toHaveBeenCalled();
  });

  it("converts a CLI-style TTL to whole seconds", async () => {
    const shareByCRID = vi.fn().mockResolvedValue({ data: sampleShareCRIDOutput() });
    const tool = shareByCRIDTool(makeMockClient({ shareByCRID }));

    await tool.handler({ crid: "crid_test", ttl: "1h30m" });

    expect(shareByCRID).toHaveBeenCalledWith("crid_test", 5400);
  });

  it("rejects oversized resource identifiers before fetching", async () => {
    const shareByCRID = vi.fn();
    const result = await shareByCRIDTool(makeMockClient({ shareByCRID })).handler({
      crid: "x".repeat(513),
    });
    expect(result.isError).toBe(true);
    expect(shareByCRID).not.toHaveBeenCalled();
  });

  it.each(["1.001s999ms", "+2s", "2.s", "2000000μs", "0.0000000001s2s"])(
    "accepts the Go duration %s as two whole seconds",
    async (ttl) => {
      const shareByCRID = vi.fn().mockResolvedValue({ data: sampleShareCRIDOutput() });
      await shareByCRIDTool(makeMockClient({ shareByCRID })).handler({ crid: "crid_test", ttl });
      expect(shareByCRID).toHaveBeenCalledWith("crid_test", 2);
    },
  );

  it.each(["0s", "-1s", "1d", "1s!", "9223372037s", "9".repeat(65) + "s"])(
    "rejects an invalid or overflowing Go duration %s",
    async (ttl) => {
      const shareByCRID = vi.fn();
      const result = await shareByCRIDTool(makeMockClient({ shareByCRID })).handler({
        crid: "crid_test",
        ttl,
      });
      expect(result.isError).toBe(true);
      expect(shareByCRID).not.toHaveBeenCalled();
    },
  );

  it("rejects a TTL that does not resolve to a positive whole number of seconds", async () => {
    const shareByCRID = vi.fn();
    const tool = shareByCRIDTool(makeMockClient({ shareByCRID }));

    const result = await tool.handler({ crid: "crid_test", ttl: "500ms" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("whole seconds");
    expect(shareByCRID).not.toHaveBeenCalled();
  });
});
