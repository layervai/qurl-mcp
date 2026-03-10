import { describe, it, expect, vi } from "vitest";
import { usageResource } from "../../resources/usage.js";
import type { QuotaOutput } from "../../client.js";
import { makeMockClient } from "../helpers.js";

const sampleQuota: QuotaOutput = {
  plan: "pro",
  limits: {
    max_qurls: 1000,
    max_sessions_per_qurl: 10,
    max_bandwidth_mb: 50000,
  },
  usage: {
    active_qurls: 42,
    total_sessions: 128,
    bandwidth_mb: 1250,
  },
};

describe("usageResource", () => {
  describe("metadata", () => {
    it("has correct URI", () => {
      const resource = usageResource(makeMockClient());
      expect(resource.uri).toBe("qurl://usage");
    });

    it("has a name", () => {
      const resource = usageResource(makeMockClient());
      expect(resource.name).toBe("QURL Usage & Quota");
    });

    it("has correct mimeType", () => {
      const resource = usageResource(makeMockClient());
      expect(resource.mimeType).toBe("application/json");
    });

    it("has a description", () => {
      const resource = usageResource(makeMockClient());
      expect(resource.description).toBeTruthy();
    });
  });

  describe("handler", () => {
    it("calls client.getQuota", async () => {
      const mockGetQuota = vi.fn().mockResolvedValue({ data: sampleQuota });
      const client = makeMockClient({ getQuota: mockGetQuota });
      const resource = usageResource(client);

      await resource.handler();

      expect(mockGetQuota).toHaveBeenCalledOnce();
    });

    it("returns contents array with URI and mimeType", async () => {
      const mockGetQuota = vi.fn().mockResolvedValue({ data: sampleQuota });
      const client = makeMockClient({ getQuota: mockGetQuota });
      const resource = usageResource(client);

      const result = await resource.handler();

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("qurl://usage");
      expect(result.contents[0].mimeType).toBe("application/json");
    });

    it("returns quota data as JSON text", async () => {
      const mockGetQuota = vi.fn().mockResolvedValue({ data: sampleQuota });
      const client = makeMockClient({ getQuota: mockGetQuota });
      const resource = usageResource(client);

      const result = await resource.handler();
      const parsed = JSON.parse(result.contents[0].text);

      expect(parsed.plan).toBe("pro");
      expect(parsed.limits.max_qurls).toBe(1000);
      expect(parsed.usage.active_qurls).toBe(42);
    });

    it("returns the data object directly, not the wrapper", async () => {
      const mockGetQuota = vi.fn().mockResolvedValue({ data: sampleQuota });
      const client = makeMockClient({ getQuota: mockGetQuota });
      const resource = usageResource(client);

      const result = await resource.handler();
      expect(result.contents[0].text).toBe(JSON.stringify(sampleQuota));
    });

    it("propagates client errors", async () => {
      const mockGetQuota = vi.fn().mockRejectedValue(new Error("Rate limited"));
      const client = makeMockClient({ getQuota: mockGetQuota });
      const resource = usageResource(client);

      await expect(resource.handler()).rejects.toThrow("Rate limited");
    });
  });
});
