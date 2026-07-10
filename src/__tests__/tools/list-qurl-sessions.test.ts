import { describe, it, expect, vi } from "vitest";
import { listQurlSessionsTool, listQurlSessionsSchema } from "../../tools/list-qurl-sessions.js";
import { makeMockClient, sampleSession } from "../helpers.js";

const resourceId = "r_abc123def45";

describe("listQurlSessionsTool", () => {
  describe("schema", () => {
    it("requires a valid resource_id", () => {
      expect(listQurlSessionsSchema.safeParse({}).success).toBe(false);
      expect(listQurlSessionsSchema.safeParse({ resource_id: "q_abc123def45" }).success).toBe(
        false,
      );
      expect(listQurlSessionsSchema.safeParse({ resource_id: resourceId }).success).toBe(true);
    });
  });

  describe("handler", () => {
    it("calls client.listResourceSessions and returns the envelope", async () => {
      const payload = { data: [sampleSession()], meta: { request_id: "req_sessions" } };
      const mockList = vi.fn().mockResolvedValue(payload);
      const tool = listQurlSessionsTool(makeMockClient({ listResourceSessions: mockList }));

      const result = await tool.handler({ resource_id: resourceId });

      expect(mockList).toHaveBeenCalledWith(resourceId);
      expect(JSON.parse(result.content[0].text)).toEqual(payload);
      expect(result.structuredContent).toEqual(payload);
    });

    it("preserves an empty session list as a successful result", async () => {
      const payload = { data: [], meta: { request_id: "req_no_sessions" } };
      const tool = listQurlSessionsTool(
        makeMockClient({ listResourceSessions: vi.fn().mockResolvedValue(payload) }),
      );

      const result = await tool.handler({ resource_id: resourceId });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(payload);
    });
  });
});
