import { describe, expect, it, vi } from "vitest";
import { maybeDeliverToolEmail, uploadEmailDetailLines } from "../../tools/email-delivery.js";

vi.mock("../../services/email.js", () => ({
  sendEmailMessage: vi.fn(),
}));

import { sendEmailMessage } from "../../services/email.js";

describe("maybeDeliverToolEmail", () => {
  it("formats shared upload details in a stable order", () => {
    expect(
      uploadEmailDetailLines({
        intro: "Ready",
        fileName: "sample.pdf",
        contentType: "application/pdf",
        qurlLink: "https://qurl.link/example",
        expiresAt: "2026-07-11T00:00:00Z",
        qurlSite: "https://example.qurl.site",
        label: "Example",
        extraLines: ["Payload Type: markdown"],
      }),
    ).toEqual([
      "Ready",
      "File Name: sample.pdf",
      "Content Type: application/pdf",
      "Secure Link: https://qurl.link/example",
      "Expires At: 2026-07-11T00:00:00Z",
      "qURL Site: https://example.qurl.site",
      "Label: Example",
      "Payload Type: markdown",
    ]);
  });

  it("reports an actionable skip before SMTP when the assembled body is oversized", async () => {
    const result = await maybeDeliverToolEmail({
      allowServerApiKeyFallback: true,
      delivery: { to: ["alice@example.com"] },
      defaultSubject: "Secure link ready",
      detailLines: ["x".repeat(10_001)],
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: false,
        enabled: true,
        sent: 0,
        failed: 1,
        skipped_reason:
          "Email delivery was not attempted because the assembled message exceeds 10,000 characters.",
      }),
    );
  });

  it("sanitizes delivery setup failures after link creation", async () => {
    vi.mocked(sendEmailMessage).mockRejectedValueOnce(new Error("smtp.private refused"));

    const result = await maybeDeliverToolEmail({
      allowServerApiKeyFallback: false,
      delivery: { to: ["alice@example.com"] },
      defaultSubject: "Secure link ready",
      detailLines: ["Secure Link: https://qurl.link/one-shot"],
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: false,
        enabled: true,
        sent: 0,
        failed: 1,
        skipped_reason: "Email delivery was not attempted because delivery setup failed.",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("smtp.private");
  });
});
