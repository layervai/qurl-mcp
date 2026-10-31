import type { IQURLClient } from "../client.js";
import {
  deliverFeedback,
  feedbackEnabled,
  FeedbackError,
  redactFeedbackMessage,
  readFeedbackResponseText,
  feedbackSchema,
  feedbackReceiptSchema,
  FEEDBACK_URL,
} from "../services/feedback.js";
import { type ToolRuntimeOptions, zodErrorToToolResult } from "./_shared.js";

export function submitFeedbackTool(
  _client?: IQURLClient,
  runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "submit_feedback",
    title: "Send LayerV feedback",
    description:
      "Send feedback about LayerV MCP to the LayerV team in Slack for human review. Use for bugs, missing features, or friction. Send only a brief report the user has authorized you to share. Never include credentials, private links, personal data, or conversation history. Receipt confirms delivery, not a promised fix. Do not automatically retry an uncertain delivery.",
    inputSchema: feedbackSchema,
    outputSchema: feedbackReceiptSchema,
    annotations: {
      title: "Send LayerV feedback",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (input: unknown) => {
      const parsed = feedbackSchema.safeParse(input);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      try {
        if (!feedbackEnabled(runtime.mode))
          throw new FeedbackError(
            503,
            "Feedback was not sent: delivery is disabled or not configured.",
          );
        let receipt;
        if (runtime.mode === "http") {
          receipt = await deliverFeedback(parsed.data);
        } else {
          // Only these explicit fields cross the boundary; no account key or CLI identity.
          const response = await fetch(FEEDBACK_URL, {
            method: "POST",
            redirect: "error",
            signal: globalThis.AbortSignal.timeout(10_000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...parsed.data,
              message: redactFeedbackMessage(parsed.data.message),
              tool_name:
                parsed.data.tool_name &&
                redactFeedbackMessage(parsed.data.tool_name) === parsed.data.tool_name
                  ? parsed.data.tool_name
                  : undefined,
            }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 429)
              throw new FeedbackError(
                429,
                "Feedback was not sent: too many reports. Try again later.",
              );
            if (response.status === 503)
              throw new FeedbackError(503, "Feedback was not sent: delivery is unavailable.");
            if ([400, 403, 413, 415].includes(response.status))
              throw new FeedbackError(
                response.status,
                "Feedback was not sent: the report was rejected.",
              );
            throw new Error("Feedback unavailable");
          }
          receipt = feedbackReceiptSchema.parse(
            JSON.parse(await readFeedbackResponseText(response, 1024)),
          );
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
          structuredContent: receipt,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof FeedbackError && error.status !== 502
                  ? error.message
                  : "Feedback delivery could not be confirmed. It may have arrived; avoid automatic retries. If this persists, contact LayerV support.",
            },
          ],
        };
      }
    },
  };
}
