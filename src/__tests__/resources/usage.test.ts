import { describe, it, expect, vi } from "vitest";
import { usageResource } from "../../resources/usage.js";
import type { QuotaOutput } from "../../client.js";
import { makeMockClient } from "../helpers.js";

const sampleQuota: QuotaOutput = {
  plan: "growth",
  period_start: "2026-03-01T00:00:00Z",
  period_end: "2026-04-01T00:00:00Z",
  rate_limits: {
    create_per_minute: 200,
    create_per_hour: 10000,
    list_per_minute: 120,
    resolve_per_minute: 300,
    max_active_qurls: 1000,
    max_active_resources: 1000,
    max_qurls: -1,
    max_data_transfer_bytes: 10737418240,
    max_expiry_seconds: 2592000,
  },
  usage: {
    qurls_created: 150,
    active_qurls: 45,
    active_resources: 45,
    active_resources_percent: 4.5,
    data_transfer_bytes: 1024,
    data_transfer_available: true,
    active_qurls_percent: 0.45,
    total_accesses: 1250,
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
      expect(resource.name).toBe("qURL Usage & Quota");
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

      expect(parsed.plan).toBe("growth");
      expect(parsed.rate_limits).toEqual(sampleQuota.rate_limits);
      expect(parsed.rate_limits).not.toHaveProperty("max_tokens_per_qurl");
      expect(parsed.usage).toEqual(sampleQuota.usage);
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
