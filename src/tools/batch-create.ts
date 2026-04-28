import { z } from "zod";
import type { BatchCreateOutput, IQURLClient } from "../client.js";
import { createQurlSchema } from "./create-qurl.js";
import { toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import { batchCreateOutputSchema } from "./output-schemas.js";

function isBatchPayload(value: unknown): value is BatchCreateOutput["data"] {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<{ succeeded: unknown; failed: unknown; results: unknown }>;
  return (
    typeof v.succeeded === "number" && typeof v.failed === "number" && Array.isArray(v.results)
  );
}

export const batchCreateSchema = z.object({
  items: z
    .array(createQurlSchema)
    .min(1)
    .max(100)
    .describe("Array of qURL creation requests (1-100 items)"),
});

export function batchCreateTool(client: IQURLClient) {
  return {
    name: "batch_create_qurls",
    title: "Batch Create qURLs",
    description:
      "Create up to 100 qURLs in a single request. The single-call alternative to looping `create_qurl` — saves round trips and returns a single envelope of per-item results. " +
      "**Not transactional:** items succeed or fail independently (see `succeeded`/`failed` counts and per-item `error`). " +
      "Use this when you need to mint many qURLs at once (e.g. provisioning a vendor list, distributing per-customer share links). " +
      "Use `create_qurl` for a single resource. " +
      "**Response shape:** `{ succeeded: number, failed: number, results: BatchItemResult[], request_id?: string }`. Each `results[i]` carries `index` (matching the input position), `success`, plus either `qurl_link` + `resource_id` + `qurl_site` + `expires_at` (success) OR `error: { code, message }` (failure). " +
      "**Partial failure signaling:** the handler sets `isError: true` on the tool response whenever `failed > 0`, so agents can branch without parsing JSON. The HTTP layer also returns 400 when every item fails — that's surfaced through the same shape (read `data.results[*].error`). " +
      "**One-shot links:** like `create_qurl`, every `qurl_link` in the response is shown ONCE. Don't lose them.",
    inputSchema: batchCreateSchema,
    outputSchema: batchCreateOutputSchema,
    annotations: {
      title: "Batch Create qURLs",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof batchCreateSchema>) => {
      const result = await client.batchCreate(input);
      // Defense-in-depth: batchCreate passes through HTTP 400, which is
      // contracted to carry a BatchCreateResponse body with per-item errors.
      // If the API ever returns 400 with a different shape (e.g., a
      // top-level malformed-request error), the downstream `failed > 0`
      // access would be meaningless — surface the raw response as an error
      // so agents get a real signal instead of silent mis-interpretation.
      if (!isBatchPayload(result.data)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unexpected batchCreate response shape: ${JSON.stringify(result).slice(0, 500)}`,
            },
          ],
          isError: true,
        };
      }
      const data = result.data;
      // Spread request_id only when present so structuredContent doesn't
      // expose an explicit `request_id: undefined` key to hosts that
      // consume the raw object (JSON.stringify drops it; structured
      // consumers don't).
      const payload = {
        ...data,
        ...(result.meta?.request_id && { request_id: result.meta.request_id }),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload),
          },
        ],
        structuredContent: toStructuredContent(payload),
        isError: data.failed > 0,
      };
    }),
  };
}
