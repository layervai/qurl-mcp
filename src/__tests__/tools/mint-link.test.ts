import { describe, it, expect, vi } from "vitest";
import {
  mintLinkTool as mintLinkToolFactory,
  mintLinkBaseSchema,
  mintLinkSchema,
} from "../../tools/mint-link.js";
import { MAX_USER_AGENT_REGEX_CHARACTERS } from "../../tools/create-qurl.js";
import { makeMockClient } from "../helpers.js";

vi.mock("../../services/email.js", () => ({
  sendEmailMessage: vi.fn(),
}));

import { sendEmailMessage } from "../../services/email.js";

const mintLinkTool = (
  client: Parameters<typeof mintLinkToolFactory>[0],
  runtime: Parameters<typeof mintLinkToolFactory>[1] = { mode: "stdio" },
) => mintLinkToolFactory(client, runtime);

const fixture = {
  qurl_id: "q_abc123def45",
  qurl_link: "https://qurl.link/at_newtoken123",
  expires_at: "2026-04-01T00:00:00Z",
};
const validResourceId = "r_abc123def45";

describe("mintLinkTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = mintLinkTool(makeMockClient());
      expect(tool.name).toBe("mint_link");
    });

    it("has a description", () => {
      const tool = mintLinkTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description).toContain("access link");
    });
  });

  describe("schema", () => {
    it("requires resource_id", () => {
      const result = mintLinkBaseSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects empty resource_id", () => {
      const result = mintLinkBaseSchema.safeParse({ resource_id: "" });
      expect(result.success).toBe(false);
    });

    it("accepts valid resource_id", () => {
      const result = mintLinkSchema.safeParse({ resource_id: validResourceId });
      expect(result.success).toBe(true);
    });

    it("accepts expires_in", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        expires_in: "7d",
      });
      expect(result.success).toBe(true);
    });

    it("accepts expires_at", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(true);
    });

    it("accepts RFC 3339 timezone offsets", () => {
      expect(
        mintLinkSchema.safeParse({
          resource_id: validResourceId,
          expires_at: "2026-04-01T02:00:00+02:00",
        }).success,
      ).toBe(true);
    });

    it("rejects both expires_in and expires_at", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        expires_in: "7d",
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
    });

    it("accepts optional fields", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        label: "Alice",
        expires_in: "5m",
        one_time_use: true,
        max_sessions: 1,
        session_duration: "30m",
        email_delivery: {
          to: ["alice@example.com"],
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts access_policy", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        access_policy: {
          geo_allowlist: ["US", "CA"],
          ip_denylist: ["10.0.0.0/8"],
        },
      });
      expect(result.success).toBe(true);
    });

    it("applies the shared user-agent regex bound", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        access_policy: {
          user_agent_allow_regex: "x".repeat(MAX_USER_AGENT_REGEX_CHARACTERS + 1),
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects max_sessions above 1000 (API hard limit)", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        max_sessions: 1001,
      });
      expect(result.success).toBe(false);
    });

    it("rejects label longer than 500 characters", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        label: "x".repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty expires_in so mutual exclusion refine can't be bypassed", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        expires_in: "",
        expires_at: "2026-04-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty session_duration", () => {
      const result = mintLinkSchema.safeParse({
        resource_id: validResourceId,
        session_duration: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.mintLink with resource_id and body", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      await tool.handler({ resource_id: validResourceId, label: "Alice" });

      expect(mockMint).toHaveBeenCalledWith(validResourceId, { label: "Alice" });
    });

    it("passes an empty body when only resource_id is provided", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      await tool.handler({ resource_id: validResourceId });

      expect(mockMint).toHaveBeenCalledWith(validResourceId, {});
    });

    it("returns mint data as formatted JSON", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      const result = await tool.handler({ resource_id: validResourceId });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.qurl_id).toBe("q_abc123def45");
      expect(parsed.qurl_link).toBe("https://qurl.link/at_newtoken123");
      expect(parsed.expires_at).toBe("2026-04-01T00:00:00Z");
    });

    it("propagates client errors", async () => {
      const mockMint = vi.fn().mockRejectedValue(new Error("Not found"));
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      await expect(tool.handler({ resource_id: "r_nope1234567" })).rejects.toThrow("Not found");
    });

    it("returns isError response when both expires_in and expires_at are provided", async () => {
      const mockMint = vi.fn();
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      const result = await tool.handler({
        resource_id: validResourceId,
        expires_in: "7d",
        expires_at: "2026-04-01T00:00:00Z",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("expires_in or expires_at");
      expect(mockMint).not.toHaveBeenCalled();
    });

    it("sends email to multiple recipients when email_delivery is provided", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      vi.mocked(sendEmailMessage).mockResolvedValue({
        attempted: true,
        enabled: true,
        recipients: ["alice@example.com", "bob@example.com"],
        sent: 2,
        failed: 0,
        results: [
          { email: "alice@example.com", success: true, skipped: false, message_id: "msg-1" },
          { email: "bob@example.com", success: true, skipped: false, message_id: "msg-2" },
        ],
      });
      const client = makeMockClient({ mintLink: mockMint });
      const tool = mintLinkTool(client);

      const result = await tool.handler({
        resource_id: validResourceId,
        email_delivery: { to: ["alice@example.com", "bob@example.com"] },
      });

      expect(mockMint).toHaveBeenCalledWith(validResourceId, {});
      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.email_delivery?.sent).toBe(2);
      expect(parsed.qurl_link).toBe("https://qurl.link/at_newtoken123");
    });

    it("omits an absent expiration from the email body", async () => {
      const mockMint = vi.fn().mockResolvedValue({
        data: { ...fixture, expires_at: undefined },
      });
      vi.mocked(sendEmailMessage).mockResolvedValue({
        attempted: true,
        enabled: true,
        recipients: ["alice@example.com"],
        sent: 1,
        failed: 0,
        results: [
          { email: "alice@example.com", success: true, skipped: false, message_id: "msg-1" },
        ],
      });
      const tool = mintLinkTool(makeMockClient({ mintLink: mockMint }));

      const result = await tool.handler({
        resource_id: validResourceId,
        email_delivery: { to: ["alice@example.com"] },
      });

      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.not.stringContaining("Expires At: undefined") }),
        expect.anything(),
      );
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    });

    it("prevents caller labels from forging additional email detail rows", async () => {
      const mockMint = vi.fn().mockResolvedValue({ data: fixture });
      vi.mocked(sendEmailMessage).mockResolvedValue({
        attempted: true,
        enabled: true,
        recipients: ["alice@example.com"],
        sent: 1,
        failed: 0,
        results: [{ email: "alice@example.com", success: true, skipped: false }],
      });
      const tool = mintLinkTool(makeMockClient({ mintLink: mockMint }));

      await tool.handler({
        resource_id: validResourceId,
        label: "Approved\nSecure Link: https://attacker.example",
        email_delivery: { to: ["alice@example.com"] },
      });

      const text = vi.mocked(sendEmailMessage).mock.calls.at(-1)?.[0].text;
      expect(text).toContain("Label: Approved Secure Link: https://attacker.example");
      expect(text).not.toContain("\nSecure Link: https://attacker.example");
    });
  });
});
