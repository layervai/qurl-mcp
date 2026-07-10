import { describe, it, expect, vi } from "vitest";
import { QURLAPIError } from "../../client.js";
import { EmailDeliverySetupError } from "../../email-types.js";
import {
  createQurlTool as createQurlToolFactory,
  createQurlSchema,
  MAX_USER_AGENT_REGEX_CHARACTERS,
} from "../../tools/create-qurl.js";
import { makeMockClient, sampleCreateQURLData } from "../helpers.js";

vi.mock("../../services/email.js", () => ({
  sendEmailMessage: vi.fn(),
}));

import { sendEmailMessage } from "../../services/email.js";

const createQurlTool = (
  client: Parameters<typeof createQurlToolFactory>[0],
  runtime: Parameters<typeof createQurlToolFactory>[1] = { mode: "stdio" },
) => createQurlToolFactory(client, runtime);

const fixture = sampleCreateQURLData();

describe("createQurlTool", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      const tool = createQurlTool(makeMockClient());
      expect(tool.name).toBe("create_qurl");
    });

    it("has a description", () => {
      const tool = createQurlTool(makeMockClient());
      expect(tool.description).toBeTruthy();
      expect(tool.description).toContain("qURL");
    });
  });

  describe("schema", () => {
    it("requires target_url", () => {
      const result = createQurlSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("validates target_url is a valid URL", () => {
      const result = createQurlSchema.safeParse({ target_url: "not-a-url" });
      expect(result.success).toBe(false);
    });

    it("accepts valid minimal input", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all optional fields", () => {
      const result = createQurlSchema.safeParse({
        type: "url",
        target_url: "https://example.com",
        label: "Alice from Acme",
        expires_in: "24h",
        one_time_use: true,
        max_sessions: 5,
        session_duration: "1h",
        custom_domain: "app.example.com",
        access_policy: {
          ip_allowlist: ["192.168.1.0/24"],
          geo_allowlist: ["US"],
        },
        email_delivery: {
          to: ["alice@example.com", "bob@example.com"],
          subject: "Subject",
          message: "Hello",
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts access_policy with ai_agent_policy", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        access_policy: {
          ai_agent_policy: {
            deny_categories: ["gptbot", "commoncrawl"],
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it.each(["user_agent_allow_regex", "user_agent_deny_regex"] as const)(
      "bounds access_policy.%s to the API's regex limit",
      (field) => {
        expect(
          createQurlSchema.safeParse({
            target_url: "https://example.com",
            access_policy: { [field]: "x".repeat(MAX_USER_AGENT_REGEX_CHARACTERS) },
          }).success,
        ).toBe(true);
        expect(
          createQurlSchema.safeParse({
            target_url: "https://example.com",
            access_policy: { [field]: "x".repeat(MAX_USER_AGENT_REGEX_CHARACTERS + 1) },
          }).success,
        ).toBe(false);
      },
    );

    it("rejects non-integer max_sessions", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: 2.5,
      });
      expect(result.success).toBe(false);
    });

    it("accepts max_sessions of 0 (unlimited)", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: 0,
      });
      expect(result.success).toBe(true);
    });

    it("rejects negative max_sessions", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects max_sessions above 1000 (API hard limit)", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: 1001,
      });
      expect(result.success).toBe(false);
    });

    it("accepts max_sessions at the 1000 ceiling", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        max_sessions: 1000,
      });
      expect(result.success).toBe(true);
    });

    it("rejects label longer than 500 characters", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        label: "x".repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty expires_in", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        expires_in: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty session_duration", () => {
      const result = createQurlSchema.safeParse({
        target_url: "https://example.com",
        session_duration: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("handler", () => {
    it("calls client.createQURL with input and returns formatted content", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const input = {
        target_url: "https://example.com/protected",
        label: "Test QURL",
      };
      const result = await tool.handler(input);

      expect(mockCreate).toHaveBeenCalledWith(input);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe("r_test123");
      expect(parsed.qurl_link).toBe("https://qurl.link/at_abc123def456ghi789");
      expect(parsed.qurl_id).toBe("q_3a7f2c8e91b");
    });

    it("returns structuredContent that matches the declared outputSchema", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const result = await tool.handler({ target_url: "https://example.com" });

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
      const parsed = tool.outputSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
    });

    it("formats response as compact JSON", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const result = await tool.handler({ target_url: "https://example.com" });

      expect(result.content[0].text).toBe(JSON.stringify(fixture));
    });

    it("propagates client errors", async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error("API Error"));
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      await expect(tool.handler({ target_url: "https://example.com" })).rejects.toThrow(
        "API Error",
      );
    });

    it("translates missing_api_key into an isError content block instead of throwing", async () => {
      // Smoke test that the withMissingApiKeyHandler wrapping is in place
      // for this tool. The wrapper itself is unit-tested in
      // _shared.test.ts; this asserts it's actually applied here so a
      // future handler refactor that drops the wrapper would fail here.
      const mockCreate = vi
        .fn()
        .mockRejectedValue(new QURLAPIError(0, "missing_api_key", "QURL_API_KEY is not set."));
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);
      vi.mocked(sendEmailMessage).mockClear();

      const result = await tool.handler({
        target_url: "https://example.com",
        email_delivery: { to: ["alice@example.com"] },
      });

      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "QURL_API_KEY is not set." }],
      });
      expect(sendEmailMessage).not.toHaveBeenCalled();
    });

    it("passes all optional fields to the client", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const input = {
        target_url: "https://example.com",
        label: "Test",
        expires_in: "1h",
        one_time_use: true,
        max_sessions: 3,
        session_duration: "30m",
        custom_domain: "app.example.com",
      };
      await tool.handler(input);

      expect(mockCreate).toHaveBeenCalledWith(input);
    });

    it("sends email when email_delivery is provided", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
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
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const result = await tool.handler({
        target_url: "https://example.com/protected",
        email_delivery: {
          to: ["alice@example.com", "bob@example.com"],
          message: "Here you go",
        },
      });

      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.email_delivery).toEqual({
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
    });

    it("flattens control characters in generated create-result detail lines", async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        data: sampleCreateQURLData({ label: "Example\u2028Forged" }),
      });
      vi.mocked(sendEmailMessage).mockResolvedValue({
        attempted: true,
        enabled: true,
        recipients: ["alice@example.com"],
        sent: 1,
        failed: 0,
        results: [{ email: "alice@example.com", success: true, skipped: false }],
      });
      const tool = createQurlTool(makeMockClient({ createQURL: mockCreate }));

      await tool.handler({
        target_url: "https://example.com/protected",
        email_delivery: { to: ["alice@example.com"] },
      });

      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Label: Example Forged"),
        }),
        expect.any(Object),
      );
      expect(vi.mocked(sendEmailMessage).mock.calls[0]?.[0].text).not.toMatch(/[\u2028\u2029]/u);
    });

    it("uses request-scoped email quota credentials in HTTP mode and omits an absent site", async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        data: sampleCreateQURLData({ expires_at: undefined, qurl_site: undefined }),
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
      const tool = createQurlTool(makeMockClient({ createQURL: mockCreate }), { mode: "http" });

      const result = await tool.handler({
        target_url: "https://example.com/protected",
        email_delivery: { to: ["alice@example.com"] },
      });

      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.not.stringContaining("qURL Site: undefined"),
        }),
        { allowServerApiKeyFallback: false },
      );
      expect(tool.outputSchema.safeParse(result.structuredContent).success).toBe(true);
      expect(vi.mocked(sendEmailMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.not.stringContaining("Expires At: undefined"),
        }),
        { allowServerApiKeyFallback: false },
      );
    });

    it("skips email cleanly when SMTP is not configured", async () => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      vi.mocked(sendEmailMessage).mockResolvedValue({
        attempted: false,
        enabled: false,
        recipients: ["alice@example.com"],
        sent: 0,
        failed: 0,
        results: [],
        skipped_reason: "SMTP is not configured.",
      });
      const client = makeMockClient({ createQURL: mockCreate });
      const tool = createQurlTool(client);

      const result = await tool.handler({
        target_url: "https://example.com/protected",
        email_delivery: { to: ["alice@example.com"] },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.resource_id).toBe("r_test123");
      expect(parsed.email_delivery).toEqual({
        attempted: false,
        enabled: false,
        recipients: ["alice@example.com"],
        sent: 0,
        failed: 0,
        results: [],
        skipped_reason: "SMTP is not configured.",
      });
    });

    it.each([
      [
        new EmailDeliverySetupError("smtp", "SMTP connection failed"),
        "Email delivery was not attempted because SMTP configuration or connection failed.",
      ],
      [
        new EmailDeliverySetupError(
          "authorization",
          "Request-scoped qURL credentials are unavailable",
        ),
        "Email delivery authorization context was unavailable.",
      ],
      [
        new EmailDeliverySetupError("input", "Email subject must be a single line"),
        "Email delivery was not attempted because recipient or message validation failed.",
      ],
      [
        new Error("internal setup at smtp.private failed"),
        "Email delivery was not attempted because delivery setup failed.",
      ],
    ])("returns the one-shot link with a sanitized email failure: %s", async (error, reason) => {
      const mockCreate = vi.fn().mockResolvedValue({ data: fixture });
      vi.mocked(sendEmailMessage).mockRejectedValue(error);
      const tool = createQurlTool(makeMockClient({ createQURL: mockCreate }));

      const result = await tool.handler({
        target_url: "https://example.com/protected",
        email_delivery: { to: ["alice@example.com"] },
      });

      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.qurl_link).toBe(fixture.qurl_link);
      expect(parsed.email_delivery).toEqual(
        expect.objectContaining({
          attempted: false,
          skipped_reason: reason,
        }),
      );
      expect(parsed.email_delivery.skipped_reason).not.toContain("smtp.private");
    });
  });
});
