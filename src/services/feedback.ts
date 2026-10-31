import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logInfo, sanitizeLogValue } from "../logging.js";

export const feedbackSchema = z.strictObject({
  category: z.enum(["bug", "feature", "friction", "other"]),
  message: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "Brief report with expected and actual behavior. Exclude secrets, personal data, links, and conversation history.",
    ),
  tool_name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,79}$/)
    .optional(),
});
export const feedbackReceiptSchema = z.object({
  feedback_id: z.string().uuid(),
  status: z.literal("sent_for_human_review"),
});
// Local agents deliberately send product feedback to LayerV, independent of their API deployment.
export const FEEDBACK_URL = "https://mcp.connector.layerv.ai/feedback";

export class FeedbackError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function feedbackWebhookUrl(): string | undefined {
  const value = process.env.MCP_FEEDBACK_SLACK_WEBHOOK_URL?.trim();
  if (!value) return undefined;
  // The secret is operator-owned; callers cannot select an outbound destination.
  if (
    !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(
      value,
    )
  ) {
    throw new Error("MCP_FEEDBACK_SLACK_WEBHOOK_URL must be a Slack incoming webhook URL.");
  }
  return value;
}

export function feedbackEnabled(mode: "stdio" | "http" = "stdio"): boolean {
  return (
    process.env.QURL_MCP_FEEDBACK?.trim().toLowerCase() !== "off" &&
    (mode === "stdio" || Boolean(feedbackWebhookUrl()))
  );
}

// shortcut: process-local Slack budget, use a shared queue if replicas need guaranteed burst delivery.
let nextSlackAttemptAt = 0;
let slackHour = -1;
let slackHourlyAttempts = 0;
export async function deliverFeedback(input: unknown) {
  const report = feedbackSchema.parse(input);
  const webhook = feedbackEnabled("http") ? feedbackWebhookUrl() : undefined;
  if (!webhook) throw new FeedbackError(503, "Feedback was not sent: delivery is not configured.");
  if (Date.now() < nextSlackAttemptAt)
    throw new FeedbackError(
      429,
      "Feedback was not sent: the review inbox is busy. Try again shortly.",
    );
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== slackHour) {
    slackHour = hour;
    slackHourlyAttempts = 0;
  }
  if (slackHourlyAttempts >= 1_000)
    throw new FeedbackError(
      429,
      "Feedback was not sent: hourly report limit reached. Try again later.",
    );
  slackHourlyAttempts += 1;
  nextSlackAttemptAt = Date.now() + 1_000;
  const feedback_id = randomUUID();
  const message = redactFeedbackMessage(report.message);
  let slackStatus: number | undefined;
  try {
    const response = await fetch(webhook, {
      method: "POST",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `LayerV MCP feedback ${feedback_id}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              emoji: false,
              text: `Untrusted agent feedback - human review required\nID: ${feedback_id}\nCategory: ${report.category}\nTool: ${sanitizeLogValue(report.tool_name ?? "unspecified")}\n${message}`,
            },
          },
        ],
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    slackStatus = response.status;
    const acknowledgement = await readFeedbackResponseText(response, 32);
    if (response.status !== 200 || acknowledgement.trim() !== "ok") {
      throw new Error("Slack did not acknowledge feedback");
    }
  } catch {
    logInfo(
      `[feedback] Slack delivery was not confirmed (${slackStatus === undefined ? "transport error" : `HTTP ${slackStatus}`}).`,
    );
    // No automatic retry: a timeout can occur after Slack accepted the message.
    throw new FeedbackError(
      502,
      "Feedback delivery could not be confirmed. It may have arrived; avoid automatic retries.",
    );
  }
  return { feedback_id, status: "sent_for_human_review" as const };
}

export async function readFeedbackResponseText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing feedback response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Feedback response too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

export function redactFeedbackMessage(message: string): string {
  return sanitizeLogValue(message)
    .replace(/(?:https?:\/\/|(?:\bwww\.|(?:[a-z0-9-]+\.)*qurl\.link\/))\S+/gi, "[link removed]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email removed]")
    .slice(0, 500);
}
