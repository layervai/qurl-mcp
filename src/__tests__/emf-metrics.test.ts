import { describe, expect, it, vi } from "vitest";
import { McpEmfMetrics } from "../emf-metrics.js";

describe("MCP EMF metrics", () => {
  it("emits peak interval utilization and snapshot-and-zero interval deltas", () => {
    let utilization = 25;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const metrics = new McpEmfMetrics(
      { namespace: "LayerV/qurl-mcp", service: "qurl-mcp", environment: "sandbox" },
      () => utilization,
    );
    metrics.incrementConcurrencyRejected();
    metrics.incrementConcurrencyRejected();
    metrics.incrementRateLimitStoreErrors();
    metrics.observeConcurrencyUtilization();
    utilization = 75;
    metrics.observeConcurrencyUtilization();
    utilization = 0;

    expect(metrics.emitHeartbeat(123)).toEqual({
      McpConcurrencyUtilization: 75,
      McpConcurrencyRejected: 2,
      McpRateLimitStoreErrors: 1,
    });
    expect(metrics.emitHeartbeat(456)).toEqual({
      McpConcurrencyUtilization: 0,
      McpConcurrencyRejected: 0,
      McpRateLimitStoreErrors: 0,
    });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toEqual(
      expect.objectContaining({
        Service: "qurl-mcp",
        Environment: "sandbox",
        McpConcurrencyRejected: 0,
        McpRateLimitStoreErrors: 0,
      }),
    );
    write.mockRestore();
  });

  it("does not emit an unstable partial identity", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const metrics = new McpEmfMetrics(undefined, () => 0);
    metrics.incrementConcurrencyRejected();
    expect(metrics.emitHeartbeat()).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(metrics.snapshotAndReset()).toEqual({
      McpConcurrencyUtilization: 0,
      McpConcurrencyRejected: 0,
      McpRateLimitStoreErrors: 0,
    });
    write.mockRestore();
  });
});
