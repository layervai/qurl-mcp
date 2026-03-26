import { vi } from "vitest";
import type { IQURLClient, QurlData, CreateQurlData } from "../client.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export function makeMockClient(overrides: Partial<IQURLClient> = {}): IQURLClient {
  return {
    createQURL: vi.fn(),
    getQURL: vi.fn(),
    listQURLs: vi.fn(),
    deleteQURL: vi.fn(),
    updateQURL: vi.fn(),
    resolveQURL: vi.fn(),
    getQuota: vi.fn(),
    mintLink: vi.fn(),
    batchCreate: vi.fn(),
    ...overrides,
  };
}

export function getPromptText(result: GetPromptResult, index = 0): string {
  const content = result.messages[index].content;
  if (typeof content === "string") return content;
  if (content.type !== "text") throw new Error(`Expected text content, got ${content.type}`);
  return content.text;
}

export function sampleQurlData(overrides: Partial<QurlData> = {}): QurlData {
  return {
    resource_id: "r_test123",
    qurl_site: "https://example.qurl.site",
    target_url: "https://example.com/protected",
    description: "Test QURL",
    tags: [],
    custom_domain: null,
    expires_at: "2026-03-10T00:00:00Z",
    created_at: "2026-03-09T00:00:00Z",
    status: "active",
    ...overrides,
  };
}

export function sampleCreateQurlData(overrides: Partial<CreateQurlData> = {}): CreateQurlData {
  return {
    qurl_id: "q_3a7f2c8e91b",
    resource_id: "r_test123",
    qurl_link: "https://qurl.link/at_abc123def456ghi789",
    qurl_site: "https://q_3a7f2c8e91b.qurl.site",
    expires_at: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}
