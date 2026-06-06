import { describe, it, expect, vi } from "vitest";
import {
  terminateQurlSessionsTool,
  terminateQurlSessionsSchema,
} from "../../tools/terminate-qurl-sessions.js";
import { makeMockClient } from "../helpers.js";

const resourceId = "r_abc123def45";

describe("terminateQurlSessionsTool", () => {
  describe("schema", () => {
    it("accepts resource_id with optional session_id", () => {
      expect(terminateQurlSessionsSchema.safeParse({ resource_id: resourceId }).success).toBe(true);
      expect(
        terminateQurlSessionsSchema.safeParse({ resource_id: resourceId, session_id: "sess_1" })
          .success,
      ).toBe(true);
    });

    it("rejects empty session_id", () => {
      expect(
        terminateQurlSessionsSchema.safeParse({ resource_id: resourceId, session_id: "" }).success,
      ).toBe(false);
    });
  });

  describe("handler", () => {
    it("terminates all sessions when session_id is omitted", async () => {
      const mockTerminateAll = vi
        .fn()
        .mockResolvedValue({ data: { terminated: 2 }, meta: { request_id: "req_term" } });
      const tool = terminateQurlSessionsTool(
        makeMockClient({ terminateAllResourceSessions: mockTerminateAll }),
      );

      const result = await tool.handler({ resource_id: resourceId });

      expect(mockTerminateAll).toHaveBeenCalledWith(resourceId);
      expect(result.structuredContent).toEqual({
        resource_id: resourceId,
        terminated: 2,
        message: "Terminated 2 qURL session(s).",
      });
    });

    it("fails cleanly when the terminate-all response is malformed", async () => {
      const mockTerminateAll = vi.fn().mockResolvedValue({ data: {} });
      const tool = terminateQurlSessionsTool(
        makeMockClient({ terminateAllResourceSessions: mockTerminateAll }),
      );

      await expect(tool.handler({ resource_id: resourceId })).rejects.toMatchObject({
        name: "QURLAPIError",
        statusCode: 502,
        code: "invalid_response",
      });
    });

    it("terminates one session when session_id is provided", async () => {
      const mockTerminateOne = vi.fn().mockResolvedValue(undefined);
      const tool = terminateQurlSessionsTool(
        makeMockClient({ terminateResourceSession: mockTerminateOne }),
      );

      const result = await tool.handler({ resource_id: resourceId, session_id: "sess_1" });

      expect(mockTerminateOne).toHaveBeenCalledWith(resourceId, "sess_1");
      expect(result.structuredContent).toEqual({
        resource_id: resourceId,
        session_id: "sess_1",
        terminated: 1,
        message: "qURL session sess_1 is terminated.",
      });
    });
  });
});
