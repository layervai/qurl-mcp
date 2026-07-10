import { z } from "zod";
import { normalizedEmailAddressSchema, uniqueRecipients } from "../email-addresses.js";
import { EmailDeliverySetupError } from "../email-types.js";
import type { EmailDeliveryResult } from "../email-types.js";
import { formatErrorForLog } from "../logging.js";
import { sendEmailMessage } from "../services/email.js";
import { flattenControlCharacters } from "../text.js";
import { toStructuredContent } from "./_shared.js";

export const emailDeliveryInputSchema = z.object({
  to: z
    .array(normalizedEmailAddressSchema)
    .min(1)
    .max(100)
    .describe(
      "One or more recipient email addresses. The server's SMTP recipient policy may enforce a lower limit.",
    ),
  subject: z
    .string()
    .max(200)
    .refine((subject) => !/[\r\n]/.test(subject), "Subject must be a single line.")
    .optional()
    .describe(
      "Optional single-line email subject. Defaults to a tool-specific subject when omitted.",
    ),
  message: z
    .string()
    .max(5000)
    .optional()
    .describe(
      "Optional plain-text message to prepend above generated qURL details. The final assembled email is limited to 10,000 characters.",
    ),
});

export type EmailDeliveryInput = z.infer<typeof emailDeliveryInputSchema>;

export interface ToolEmailInput {
  allowServerApiKeyFallback: boolean;
  delivery?: EmailDeliveryInput;
  defaultSubject: string;
  detailLines: string[];
}

export interface UploadEmailDetails {
  intro: string;
  fileName: string;
  contentType: string;
  qurlLink: string;
  expiresAt?: string;
  qurlSite?: string;
  label?: string;
  extraLines?: string[];
}

function singleLineEmailDetail(value: string): string {
  return flattenControlCharacters(value);
}

export function uploadEmailDetailLines(details: UploadEmailDetails): string[] {
  return [
    details.intro,
    `File Name: ${singleLineEmailDetail(details.fileName)}`,
    `Content Type: ${singleLineEmailDetail(details.contentType)}`,
    `Secure Link: ${singleLineEmailDetail(details.qurlLink)}`,
    ...(details.expiresAt ? [`Expires At: ${singleLineEmailDetail(details.expiresAt)}`] : []),
    ...(details.qurlSite ? [`qURL Site: ${singleLineEmailDetail(details.qurlSite)}`] : []),
    ...(details.label ? [`Label: ${singleLineEmailDetail(details.label)}`] : []),
    ...(details.extraLines ?? []),
  ];
}

// Match toStructuredContent's plain-object boundary; `length?: never` keeps
// arrays from being silently spread into numeric object keys.
export function toEmailAugmentedResult<T extends object & { length?: never }>(
  base: T,
  emailResult: EmailDeliveryResult | undefined,
) {
  const payload = emailResult ? { ...base, email_delivery: emailResult } : base;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: toStructuredContent(payload),
  };
}

function getSanitizedDeliveryFailureReason(error: unknown): string {
  if (error instanceof EmailDeliverySetupError) {
    switch (error.kind) {
      case "authorization":
        return "Email delivery authorization context was unavailable.";
      case "smtp":
        return "Email delivery was not attempted because SMTP configuration or connection failed.";
      case "input":
        return "Email delivery was not attempted because recipient or message validation failed.";
    }
  }
  return "Email delivery was not attempted because delivery setup failed.";
}

function skippedDeliveryResult(recipients: string[], skippedReason: string): EmailDeliveryResult {
  return {
    attempted: false,
    enabled: true,
    recipients,
    sent: 0,
    failed: recipients.length,
    results: recipients.map((email) => ({
      email,
      success: false,
      skipped: true,
      error: skippedReason,
    })),
    skipped_reason: skippedReason,
  };
}

export async function maybeDeliverToolEmail(
  input: ToolEmailInput,
): Promise<EmailDeliveryResult | undefined> {
  if (!input.delivery) return undefined;

  const subject = flattenControlCharacters(
    input.delivery.subject?.trim() || input.defaultSubject.trim(),
  );
  // Preserve formatting in the caller-authored message because it is sent only
  // as the plain-text body. Generated detail fields are flattened separately
  // so an untrusted value cannot visually create another structured detail row.
  const sections = [
    input.delivery.message?.trim(),
    input.detailLines.join("\n"),
    "Sent by qURL.",
  ].filter((section): section is string => typeof section === "string" && section.length > 0);
  const text = sections.join("\n\n");
  const recipients = uniqueRecipients(input.delivery.to);
  // Fail with a structured skipped result here for tool callers. The service
  // repeats this boundary check because it is also exported for direct use.
  // Match Zod's UTF-16-unit maxLength semantics for caller-provided sections.
  if (text.length > 10_000) {
    return skippedDeliveryResult(
      recipients,
      "Email delivery was not attempted because the assembled message exceeds 10,000 characters.",
    );
  }

  try {
    return await sendEmailMessage(
      {
        to: recipients,
        subject,
        text,
      },
      { allowServerApiKeyFallback: input.allowServerApiKeyFallback },
    );
  } catch (error) {
    // Link creation has already succeeded when this helper runs. Never turn a
    // delivery failure into a failed tool call because qurl_link is one-shot
    // output that cannot be recovered later.
    console.error(`Email delivery failed after qURL creation (${formatErrorForLog(error)})`);
    const skippedReason = getSanitizedDeliveryFailureReason(error);
    return skippedDeliveryResult(recipients, skippedReason);
  }
}
