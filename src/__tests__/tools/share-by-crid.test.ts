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
    expect(tool.description).toContain("beginning with `$`");
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

  it("rejects a TTL that does not resolve to a positive whole number of seconds", async () => {
    const shareByCRID = vi.fn();
    const tool = shareByCRIDTool(makeMockClient({ shareByCRID }));

    const result = await tool.handler({ crid: "crid_test", ttl: "500ms" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("whole seconds");
    expect(shareByCRID).not.toHaveBeenCalled();
  });
});
