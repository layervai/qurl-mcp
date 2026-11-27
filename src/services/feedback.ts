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
    public readonly retryAfterSeconds?: number,
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
      1,
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
      Math.ceil((3_600_000 - (Date.now() % 3_600_000)) / 1_000),
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
        ...feedbackSlackMessage(report.category, report.tool_name, message, feedback_id),
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

const CATEGORY_LABELS = {
  bug: ":beetle: Bug report",
  feature: ":bulb: Feature request",
  friction: ":confused: Hard to use",
  other: ":speech_balloon: Feedback",
} as const;
// App clients prefix their reports. The endpoint is public, so a prefix only labels the
// message; anyone (including an agent) can claim one, and it grants nothing.
const APP_SOURCES: Record<string, { source: string; sandbox: boolean }> = {
  "[qURL Desktop] ": { source: "qURL Desktop", sandbox: false },
  "[qURL Desktop Staging] ": { source: "qURL Desktop", sandbox: true },
  "[qURL Mobile] ": { source: "qURL Mobile", sandbox: false },
  "[qURL Mobile Sandbox] ": { source: "qURL Mobile", sandbox: true },
};

// Only server-chosen strings reach mrkdwn; report text stays plain_text so it cannot mention, link, or format.
export function feedbackSlackMessage(
  category: keyof typeof CATEGORY_LABELS,
  toolName: string | undefined,
  redactedMessage: string,
  feedbackId: string,
) {
  const prefix = Object.keys(APP_SOURCES).find((p) => redactedMessage.startsWith(p));
  const app = prefix ? APP_SOURCES[prefix] : undefined;
  const source = app?.source ?? "AI agent (MCP)";
  const body = prefix ? redactedMessage.slice(prefix.length) : redactedMessage;
  const label = CATEGORY_LABELS[category];
  const ref = `Ref ${feedbackId.slice(0, 8)}`;
  // Slack parses <, >, & in top-level text even when blocks are present.
  const preview = (body.length > 80 ? `${body.slice(0, 79)}…` : body)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return {
    text: `${label.replace(/^:[a-z_]+: /, "")} from ${source}: ${preview}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${label}*  ·  ${source}${app?.sandbox ? "  ·  Sandbox" : ""}`,
        },
      },
      { type: "section", text: { type: "plain_text", emoji: false, text: body } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: app
              ? `Sent from the app · ${ref}`
              : // tool_name is schema-limited to [a-z0-9_]; the code span keeps "_" from italicizing.
                `Written by an AI agent, not a person · check before acting · Tool: ${toolName ? `\`${toolName}\`` : "none"} · ${ref}`,
          },
        ],
      },
    ],
  };
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
    .replace(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b/g, "[email removed]")
    .slice(0, 500);
}
