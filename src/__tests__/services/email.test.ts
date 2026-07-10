import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithRequestAuthContext } from "../../auth/request-context.js";

const nodemailerMocks = vi.hoisted(() => {
  const sendMail = vi.fn();
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close }));
  return { sendMail, close, createTransport };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: nodemailerMocks.createTransport,
  },
}));

import { clearRuntimeConfigCache } from "../../config.js";
import {
  clearEmailQuotaState,
  hasEmailQuotaTrackingCapacity,
  sendEmailMessage,
} from "../../services/email.js";

describe("sendEmailMessage", () => {
  const originalConfigPath = process.env.QURL_MCP_CONFIG;
  const originalSmtpHost = process.env.QURL_SMTP_HOST;
  const originalSmtpPort = process.env.QURL_SMTP_PORT;
  const originalSmtpSecure = process.env.QURL_SMTP_SECURE;
  const originalSmtpUsername = process.env.QURL_SMTP_USERNAME;
  const originalSmtpPassword = process.env.QURL_SMTP_PASSWORD;
  const originalSmtpFromEmail = process.env.QURL_SMTP_FROM_EMAIL;
  const originalSmtpFromName = process.env.QURL_SMTP_FROM_NAME;
  const originalAllowedRecipients = process.env.QURL_SMTP_ALLOWED_RECIPIENTS;
  const originalAllowedRecipientDomains = process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS;
  const originalApiKey = process.env.QURL_API_KEY;
  let tempDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    clearEmailQuotaState();
    clearRuntimeConfigCache();
    delete process.env.QURL_SMTP_HOST;
    delete process.env.QURL_SMTP_PORT;
    delete process.env.QURL_SMTP_SECURE;
    delete process.env.QURL_SMTP_USERNAME;
    delete process.env.QURL_SMTP_PASSWORD;
    delete process.env.QURL_SMTP_FROM_EMAIL;
    delete process.env.QURL_SMTP_FROM_NAME;
    delete process.env.QURL_SMTP_ALLOWED_RECIPIENTS;
    process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS = "example.com";
    delete process.env.QURL_API_KEY;
    tempDir = mkdtempSync(join(tmpdir(), "qurl-email-test-"));
  });

  afterEach(() => {
    process.env.QURL_MCP_CONFIG = originalConfigPath;
    process.env.QURL_SMTP_HOST = originalSmtpHost;
    process.env.QURL_SMTP_PORT = originalSmtpPort;
    process.env.QURL_SMTP_SECURE = originalSmtpSecure;
    process.env.QURL_SMTP_USERNAME = originalSmtpUsername;
    process.env.QURL_SMTP_PASSWORD = originalSmtpPassword;
    process.env.QURL_SMTP_FROM_EMAIL = originalSmtpFromEmail;
    process.env.QURL_SMTP_FROM_NAME = originalSmtpFromName;
    process.env.QURL_SMTP_ALLOWED_RECIPIENTS = originalAllowedRecipients;
    process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS = originalAllowedRecipientDomains;
    process.env.QURL_API_KEY = originalApiKey;
    clearEmailQuotaState();
    clearRuntimeConfigCache();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("skips delivery when SMTP is not configured", async () => {
    const configPath = join(tempDir!, "qurl-mcp.http.json");
    writeFileSync(configPath, JSON.stringify({ defaultQurlApiUrl: "https://api.layerv.ai" }));
    process.env.QURL_MCP_CONFIG = configPath;

    const result = await sendEmailMessage({
      to: ["alice@example.com"],
      subject: "Hello",
      text: "World",
    });

    expect(result).toEqual({
      attempted: false,
      enabled: false,
      recipients: ["alice@example.com"],
      sent: 0,
      failed: 0,
      results: [],
      skipped_reason: "SMTP is not configured.",
    });
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("fails closed when SMTP has no recipient allowlist", async () => {
    delete process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS;
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;

    const result = await sendEmailMessage({
      to: ["attacker@elsewhere.test"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: false,
        enabled: true,
        sent: 0,
        failed: 1,
        skipped_reason: expect.stringContaining("requires at least one configured allowed"),
      }),
    );
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("rejects invalid recipients and header-injection subjects before SMTP", async () => {
    await expect(
      sendEmailMessage({ to: ["not-an-email"], subject: "Hello", text: "World" }),
    ).rejects.toThrow("valid addresses");
    await expect(
      sendEmailMessage({
        to: [`${"a".repeat(250)}@example.com`],
        subject: "Hello",
        text: "World",
      }),
    ).rejects.toThrow("valid addresses");
    await expect(
      sendEmailMessage({
        to: ["alice@example.com"],
        subject: "Hello\r\nBcc: attacker@example.com",
        text: "World",
      }),
    ).rejects.toThrow("single line");
    await expect(
      sendEmailMessage({
        to: ["alice@example.com"],
        subject: "Hello\u0085Bcc: attacker@example.com",
        text: "World",
      }),
    ).rejects.toThrow("single line");
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("rejects header injection in the configured SMTP from name", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          fromName: "qURL\r\nBcc: attacker@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;

    await expect(
      sendEmailMessage({ to: ["alice@example.com"], subject: "Hello", text: "World" }),
    ).rejects.toThrow("SMTP fromName must be a single line");
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("rejects header injection in the configured SMTP from email", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com\r\nBcc: attacker@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;

    await expect(
      sendEmailMessage({ to: ["alice@example.com"], subject: "Hello", text: "World" }),
    ).rejects.toThrow("SMTP fromEmail must be a single line");
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("rejects SMTP ports outside the TCP port range", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 999_999,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;

    await expect(
      sendEmailMessage({ to: ["alice@example.com"], subject: "Hello", text: "World" }),
    ).rejects.toThrow("between 1 and 65535");
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it.each(["0x10", "1e3", "3.0"])(
    "rejects non-decimal SMTP recipient limit %s",
    async (maxRecipientsPerMessage) => {
      const configPath = join(tempDir!, "qurl-mcp.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          smtp: {
            host: "smtp.example.com",
            port: 587,
            secure: false,
            username: "mailer",
            password: "secret",
            fromEmail: "noreply@example.com",
            maxRecipientsPerMessage,
          },
        }),
      );
      process.env.QURL_MCP_CONFIG = configPath;

      await expect(
        sendEmailMessage({ to: ["alice@example.com"], subject: "Hello", text: "World" }),
      ).rejects.toThrow("must be a positive integer");
      expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
    },
  );

  it("requires a request-scoped quota principal when server-key fallback is disabled", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    process.env.QURL_API_KEY = "lv_server_key_must_not_be_used";

    await expect(
      sendEmailMessage(
        { to: ["alice@example.com"], subject: "Hello", text: "World" },
        { allowServerApiKeyFallback: false },
      ),
    ).rejects.toThrow("Request-scoped qURL credentials are unavailable");
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("sends one email per unique recipient using shared config-file SMTP settings", async () => {
    const configPath = join(tempDir!, "qurl-mcp.http.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultQurlApiUrl: "https://api.layerv.ai",
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          fromName: "qURL",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail
      .mockResolvedValueOnce({ messageId: "msg-1" })
      .mockResolvedValueOnce({ messageId: "msg-2" });

    const result = await sendEmailMessage({
      to: ["Alice@example.com", "bob@example.com", "alice@example.com"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(nodemailerMocks.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: "mailer",
        pass: "secret",
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    expect(nodemailerMocks.sendMail).toHaveBeenCalledTimes(2);
    expect(nodemailerMocks.sendMail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        from: { name: "qURL", address: "noreply@example.com" },
        to: "alice@example.com",
        subject: "Secure link ready",
      }),
    );
    expect(nodemailerMocks.sendMail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: "bob@example.com",
        subject: "Secure link ready",
      }),
    );
    expect(result).toEqual({
      attempted: true,
      enabled: true,
      recipients: ["alice@example.com", "bob@example.com"],
      sent: 2,
      failed: 0,
      results: [
        {
          email: "alice@example.com",
          success: true,
          skipped: false,
          message_id: "msg-1",
        },
        {
          email: "bob@example.com",
          success: true,
          skipped: false,
          message_id: "msg-2",
        },
      ],
    });
    expect(nodemailerMocks.close).toHaveBeenCalledOnce();
  });

  it("configures implicit TLS when smtp.secure is true", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 465,
          secure: true,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail.mockResolvedValue({ messageId: "msg-tls" });
    nodemailerMocks.close.mockImplementationOnce(() => {
      throw new Error("cleanup unavailable");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await sendEmailMessage({
      to: ["alice@example.com"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(result.sent).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SMTP transport cleanup failed"));
    expect(nodemailerMocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });

  it("falls back to file SMTP port and TLS settings when environment values are empty", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 465,
          secure: true,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    process.env.QURL_SMTP_PORT = " ";
    process.env.QURL_SMTP_SECURE = "";
    nodemailerMocks.sendMail.mockResolvedValue({ messageId: "msg-file-tls" });

    const result = await sendEmailMessage({
      to: ["alice@example.com"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(result.sent).toBe(1);
    expect(nodemailerMocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });

  it("records per-recipient SMTP failures and still closes the transport", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mail+er",
          password: "s ecret",
          fromEmail: "noreply@example.com",
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail
      .mockRejectedValueOnce(
        new Error(
          "smtp.internal: mail%2Ber s%20ecret bWFpbCtlcg== cyBlY3JldA== recipient mailbox unavailable",
        ),
      )
      .mockResolvedValueOnce({ messageId: "msg-2" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await sendEmailMessage({
      to: ["first@example.com", "second@example.com"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: true,
        sent: 1,
        failed: 1,
        results: [
          expect.objectContaining({
            email: "first@example.com",
            success: false,
            error: "Email delivery failed.",
          }),
          expect.objectContaining({
            email: "second@example.com",
            success: true,
            message_id: "msg-2",
          }),
        ],
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("recipient mailbox unavailable"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("mail%2Ber"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("s%20ecret"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("bWFpbCtlcg=="));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("cyBlY3JldA=="));
    expect(JSON.stringify(result)).not.toContain("smtp.internal");
    expect(nodemailerMocks.close).toHaveBeenCalledOnce();
  });

  it("rejects a message above the configured per-message recipient cap", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          maxRecipientsPerMessage: 1,
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;

    const result = await sendEmailMessage({
      to: ["alice@example.com", "bob@example.com"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(result.attempted).toBe(false);
    expect(result.skipped_reason).toContain("per-message limit of 1");
    expect(nodemailerMocks.createTransport).not.toHaveBeenCalled();
  });

  it("enforces recipient allowlists without attempting blocked deliveries", async () => {
    delete process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS;
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          allowedRecipientDomains: ["EXAMPLE.COM."],
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail.mockResolvedValue({ messageId: "msg-1" });

    const result = await sendEmailMessage({
      to: ["Allowed@ExAmPlE.CoM", "blocked@mail.example.com", "blocked@elsewhere.test"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(nodemailerMocks.sendMail).toHaveBeenCalledOnce();
    expect(nodemailerMocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "allowed@example.com" }),
    );
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        email: "blocked@mail.example.com",
        success: false,
        skipped: true,
      }),
    );
    expect(result.results).toContainEqual(
      expect.objectContaining({
        email: "blocked@elsewhere.test",
        success: false,
        skipped: true,
      }),
    );

    const allBlocked = await sendEmailMessage({
      to: ["blocked@elsewhere.test"],
      subject: "Secure link ready",
      text: "Body",
    });
    expect(allBlocked).toEqual(expect.objectContaining({ attempted: false, sent: 0, failed: 1 }));
    expect(nodemailerMocks.close).toHaveBeenCalledOnce();
  });

  it("normalizes mixed-case IDNA addresses before exact-recipient allowlist matching", async () => {
    delete process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS;
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          allowedRecipients: ["Alice@BÜCHER.Example."],
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail.mockResolvedValue({ messageId: "msg-idna" });

    const result = await sendEmailMessage({
      to: ["ALICE@bücher.example", "bob@bücher.example"],
      subject: "Secure link ready",
      text: "Body",
    });

    expect(nodemailerMocks.sendMail).toHaveBeenCalledOnce();
    expect(nodemailerMocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "alice@xn--bcher-kva.example" }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        sent: 1,
        failed: 1,
        recipients: ["alice@xn--bcher-kva.example", "bob@xn--bcher-kva.example"],
      }),
    );
  });

  it("fails closed when a new principal would exceed quota tracking capacity", () => {
    expect(hasEmailQuotaTrackingCapacity(true, 10_000)).toBe(true);
    expect(hasEmailQuotaTrackingCapacity(false, 9_999)).toBe(true);
    expect(hasEmailQuotaTrackingCapacity(false, 10_000)).toBe(false);
  });

  it("enforces and resets the per-key fixed hourly recipient quota", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          maxRecipientsPerHour: 1,
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    process.env.QURL_API_KEY = "lv_live_quota_test";
    nodemailerMocks.sendMail.mockResolvedValue({ messageId: "msg-1" });
    const now = vi.spyOn(Date, "now").mockReturnValue(0);

    const first = await sendEmailMessage({
      to: ["first@example.com"],
      subject: "First",
      text: "Body",
    });
    now.mockReturnValue(60 * 60 * 1000 - 1);
    const second = await sendEmailMessage({
      to: ["second@example.com"],
      subject: "Second",
      text: "Body",
    });
    now.mockReturnValue(60 * 60 * 1000 + 1);
    const afterWindow = await sendEmailMessage({
      to: ["third@example.com"],
      subject: "Third",
      text: "Body",
    });

    expect(first.sent).toBe(1);
    expect(second.attempted).toBe(false);
    expect(second.skipped_reason).toContain("hourly limit of 1");
    expect(afterWindow.sent).toBe(1);
    expect(nodemailerMocks.sendMail).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("tracks two request-scoped principals independently", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          maxRecipientsPerHour: 1,
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail.mockResolvedValue({ messageId: "msg-principal" });
    const sendAs = (qurlApiKey: string, to: string) =>
      runWithRequestAuthContext({ qurlApiKey }, () =>
        sendEmailMessage(
          { to: [to], subject: "Secure link", text: "Body" },
          { allowServerApiKeyFallback: false },
        ),
      );

    const [firstPrincipal, secondPrincipal] = await Promise.all([
      sendAs("lv_live_principal_a", "alice@example.com"),
      sendAs("lv_live_principal_b", "bob@example.com"),
    ]);
    const repeatedFirstPrincipal = await sendAs("lv_live_principal_a", "alice-again@example.com");

    expect(firstPrincipal.sent).toBe(1);
    expect(secondPrincipal.sent).toBe(1);
    expect(repeatedFirstPrincipal.attempted).toBe(false);
    expect(repeatedFirstPrincipal.skipped_reason).toContain("hourly limit of 1");
    expect(nodemailerMocks.sendMail).toHaveBeenCalledTimes(2);
  });

  it("reserves a brand-new same-principal quota atomically across concurrent calls", async () => {
    const configPath = join(tempDir!, "qurl-mcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          username: "mailer",
          password: "secret",
          fromEmail: "noreply@example.com",
          maxRecipientsPerHour: 1,
        },
      }),
    );
    process.env.QURL_MCP_CONFIG = configPath;
    nodemailerMocks.sendMail.mockResolvedValue({ messageId: "msg-concurrent" });
    const send = (to: string) =>
      runWithRequestAuthContext({ qurlApiKey: "lv_live_same_principal" }, () =>
        sendEmailMessage(
          { to: [to], subject: "Secure link", text: "Body" },
          { allowServerApiKeyFallback: false },
        ),
      );

    const results = await Promise.all([send("first@example.com"), send("second@example.com")]);

    expect(results.map((result) => result.sent).sort()).toEqual([0, 1]);
    expect(nodemailerMocks.sendMail).toHaveBeenCalledOnce();
  });
});
