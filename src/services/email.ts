import { Buffer } from "node:buffer";
import { hkdf, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { getRequestQurlApiKey } from "../auth/request-context.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../config.js";
import { isEmailAddress, normalizeEmailDomain, uniqueRecipients } from "../email-addresses.js";
import { EmailDeliverySetupError } from "../email-types.js";
import type { EmailDeliveryRecipientResult, EmailDeliveryResult } from "../email-types.js";
import { formatErrorForLog } from "../logging.js";

// Nodemailer v9 does not publish bundled declarations. @types/nodemailer v8
// is the current DefinitelyTyped line for TypeScript 6 and covers the
// createTransport/sendMail surface used here.

export interface EmailMessageInput {
  to: string[];
  subject: string;
  text: string;
}

export interface EmailMessageOptions {
  allowServerApiKeyFallback?: boolean;
}

export function hasEmailQuotaTrackingCapacity(
  principalAlreadyTracked: boolean,
  trackedPrincipalCount: number,
): boolean {
  return principalAlreadyTracked || trackedPrincipalCount < 10_000;
}

type EmailQuota = { recipients: number; windowStartedAt: number };
const emailQuotaByPrincipal = new Map<string, EmailQuota>();
// This is intentionally a fixed window. It provides a bounded, retry-proof
// process-local abuse guard; operators needing a strict sliding aggregate
// policy should enforce it at the SMTP provider or gateway across replicas.
const EMAIL_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_QUOTA_SALT = randomBytes(16);

export function clearEmailQuotaState(): void {
  emailQuotaByPrincipal.clear();
}

function skippedRecipientResults(
  recipients: string[],
  error: string,
): EmailDeliveryRecipientResult[] {
  return recipients.map((email) => ({
    email,
    success: false,
    skipped: true,
    error,
  }));
}

function blockedRecipientResults(recipients: string[]): EmailDeliveryRecipientResult[] {
  return skippedRecipientResults(recipients, "Recipient is not allowed by SMTP policy.");
}

async function deriveEmailQuotaPrincipal(principalKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // qURL API keys are high-entropy credentials, so HKDF is the appropriate
    // low-cost one-way derivation. A password KDF such as scrypt adds latency
    // without improving resistance to guessing attacks here.
    hkdf("sha256", principalKey, EMAIL_QUOTA_SALT, "qurl-mcp-email-quota", 32, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(key).toString("hex"));
    });
  });
}

export async function sendEmailMessage(
  input: EmailMessageInput,
  options: EmailMessageOptions = {},
): Promise<EmailDeliveryResult> {
  const recipients = uniqueRecipients(input.to);
  if (recipients.length === 0) {
    return {
      attempted: false,
      enabled: false,
      recipients,
      sent: 0,
      failed: 0,
      results: [],
      skipped_reason: "No email recipients were provided.",
    };
  }
  if (recipients.some((recipient) => recipient.length > 254 || !isEmailAddress(recipient))) {
    throw new EmailDeliverySetupError("input", "Email recipients must be valid addresses.");
  }
  if (!input.subject.trim() || input.subject.length > 200 || /[\r\n]/.test(input.subject)) {
    throw new EmailDeliverySetupError("input", "Email subject must be a non-empty single line.");
  }
  // Defense at the exported service boundary; tool assembly also checks this
  // limit so it can return a structured skipped-delivery result.
  if (input.text.length > 10_000) {
    throw new EmailDeliverySetupError("input", "Email text exceeds the 10,000 character limit.");
  }

  let runtimeConfig: RuntimeConfig;
  try {
    runtimeConfig = loadRuntimeConfig();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "SMTP configuration could not be loaded.";
    throw new EmailDeliverySetupError("smtp", message, { cause: error });
  }
  const smtp = runtimeConfig.smtp;
  if (!smtp) {
    return {
      attempted: false,
      enabled: false,
      recipients,
      sent: 0,
      failed: 0,
      results: [],
      skipped_reason: "SMTP is not configured.",
    };
  }
  // Revalidate sender headers at the delivery boundary as defense in depth in
  // case callers provide a RuntimeConfig through a future non-file source.
  if (
    /[\r\n]/.test(smtp.fromEmail) ||
    smtp.fromEmail.length > 254 ||
    !isEmailAddress(smtp.fromEmail)
  ) {
    throw new EmailDeliverySetupError(
      "smtp",
      "SMTP fromEmail must be a valid single-line email address.",
    );
  }
  if (smtp.fromName && (/[\r\n]/.test(smtp.fromName) || smtp.fromName.length > 200)) {
    throw new EmailDeliverySetupError(
      "smtp",
      "SMTP fromName must be a single line of at most 200 characters.",
    );
  }

  if (recipients.length > smtp.maxRecipientsPerMessage) {
    // Cap the complete requested fan-out before allowlist filtering. This is
    // intentionally stricter than the hourly quota's delivered-recipient
    // count so blocked addresses cannot be used to submit oversized batches.
    return {
      attempted: false,
      enabled: true,
      recipients,
      sent: 0,
      failed: recipients.length,
      results: skippedRecipientResults(
        recipients,
        "Recipient count exceeds the configured SMTP policy limit.",
      ),
      skipped_reason: `Recipient count exceeds the configured per-message limit of ${smtp.maxRecipientsPerMessage}.`,
    };
  }

  const exactAllowlist = new Set(smtp.allowedRecipients ?? []);
  const domainAllowlist = new Set(smtp.allowedRecipientDomains ?? []);
  const hasRecipientRestrictions = exactAllowlist.size > 0 || domainAllowlist.size > 0;
  const allowedRecipients: string[] = [];
  const blockedRecipients: string[] = [];
  for (const recipient of recipients) {
    // Recipient normalization and config parsing lowercase both sides before
    // this exact-address/domain comparison.
    const domain = normalizeEmailDomain(recipient.slice(recipient.lastIndexOf("@") + 1));
    const isAllowed =
      !hasRecipientRestrictions || exactAllowlist.has(recipient) || domainAllowlist.has(domain);
    (isAllowed ? allowedRecipients : blockedRecipients).push(recipient);
  }

  if (allowedRecipients.length === 0) {
    return {
      attempted: false,
      enabled: true,
      recipients,
      sent: 0,
      failed: blockedRecipients.length,
      skipped_reason: "No recipient matched the configured SMTP recipient allowlist.",
      results: blockedRecipientResults(blockedRecipients),
    };
  }

  const requestApiKey = getRequestQurlApiKey();
  if (options.allowServerApiKeyFallback === false && !requestApiKey) {
    throw new EmailDeliverySetupError(
      "authorization",
      "Request-scoped qURL credentials are unavailable for email quota tracking.",
    );
  }
  // Registered tools reject a missing qURL key before reaching delivery. The
  // fallback bucket exists only for direct service embedding/tests, where no
  // credential principal is available and sharing one conservative quota is
  // safer than disabling quota enforcement.
  const principalKey = requestApiKey ?? runtimeConfig.qurlApiKey ?? "unscoped";
  const quotaSkipResult = (skippedReason: string, allowedMessage: string): EmailDeliveryResult => ({
    attempted: false,
    enabled: true,
    recipients,
    sent: 0,
    failed: recipients.length,
    results: [
      ...blockedRecipientResults(blockedRecipients),
      ...skippedRecipientResults(allowedRecipients, allowedMessage),
    ],
    skipped_reason: skippedReason,
  });
  const principal = await deriveEmailQuotaPrincipal(principalKey);
  // Promise continuations resume one at a time on the JavaScript event loop.
  // From this await through quota increment/map update there are no further
  // await points, so even concurrent first requests for one principal cannot
  // both observe and reserve the same empty quota bucket.
  const now = Date.now();
  for (const [key, quota] of emailQuotaByPrincipal) {
    if (now - quota.windowStartedAt >= EMAIL_QUOTA_WINDOW_MS) emailQuotaByPrincipal.delete(key);
  }
  if (
    !hasEmailQuotaTrackingCapacity(emailQuotaByPrincipal.has(principal), emailQuotaByPrincipal.size)
  ) {
    // Fail closed instead of evicting a live principal. LRU eviction would let
    // an attacker cycle keys until a prior key's quota state disappears, then
    // reuse that key to bypass the hourly recipient limit.
    return quotaSkipResult(
      "Email quota tracking capacity has been reached. Try again later.",
      "Email delivery was skipped because quota tracking is at capacity.",
    );
  }
  const quota = emailQuotaByPrincipal.get(principal) ?? { recipients: 0, windowStartedAt: now };
  if (quota.recipients + allowedRecipients.length > smtp.maxRecipientsPerHour) {
    return quotaSkipResult(
      `Recipient quota exceeds the configured per-key hourly limit of ${smtp.maxRecipientsPerHour}.`,
      "Email delivery was skipped because the hourly quota was reached.",
    );
  }
  // Count attempted recipients, not only successful sends. Refunding failures
  // would let a failing or adversarial SMTP destination bypass the abuse cap
  // by retrying indefinitely.
  emailQuotaByPrincipal.set(principal, {
    ...quota,
    recipients: quota.recipients + allowedRecipients.length,
  });

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // Port 587-style connections must upgrade before credentials or qURL
    // links are sent. Implicit-TLS transports are already encrypted.
    requireTLS: !smtp.secure,
    auth: {
      user: smtp.username,
      pass: smtp.password,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  const from = smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail;

  const results = blockedRecipientResults(blockedRecipients);
  try {
    for (const recipient of allowedRecipients) {
      try {
        const sent = await transporter.sendMail({
          from,
          to: recipient,
          subject: input.subject,
          text: input.text,
        });
        results.push({
          email: recipient,
          success: true,
          skipped: false,
          message_id: sent.messageId,
        });
      } catch (error) {
        console.error(`Email delivery to one recipient failed (${formatErrorForLog(error)})`);
        results.push({
          email: recipient,
          success: false,
          skipped: false,
          error: "Email delivery failed.",
        });
      }
    }
  } finally {
    try {
      transporter.close();
    } catch (error) {
      // Transport cleanup must never replace the delivery outcome.
      console.error(`SMTP transport cleanup failed (${formatErrorForLog(error)})`);
    }
  }

  const sentCount = results.filter((result) => result.success).length;
  return {
    attempted: true,
    enabled: true,
    recipients,
    sent: sentCount,
    failed: results.length - sentCount,
    results,
  };
}
