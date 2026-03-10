import { vi } from "vitest";
import type { QURLClient, QURL } from "../client.js";

export function makeMockClient(overrides: Partial<QURLClient> = {}): QURLClient {
  return {
    createQURL: vi.fn(),
    getQURL: vi.fn(),
    listQURLs: vi.fn(),
    deleteQURL: vi.fn(),
    extendQURL: vi.fn(),
    resolveQURL: vi.fn(),
    getQuota: vi.fn(),
    ...overrides,
  } as unknown as QURLClient;
}

export function sampleQURL(overrides: Partial<QURL> = {}): QURL {
  return {
    resource_id: "r_test123",
    qurl_link: "https://qurl.link/at_abc",
    qurl_site: "https://example.qurl.site",
    target_url: "https://example.com/protected",
    description: "Test QURL",
    expires_at: "2026-03-10T00:00:00Z",
    created_at: "2026-03-09T00:00:00Z",
    status: "active",
    access_count: 0,
    one_time_use: false,
    max_sessions: 1,
    ...overrides,
  };
}
