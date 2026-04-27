import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { resourceIdSchema, withMissingApiKeyHandler } from "./_shared.js";
import { extendQurlOutputSchema } from "./output-schemas.js";

export const extendQurlSchema = z.object({
  resource_id: resourceIdSchema("extend"),
  extend_by: z.string().min(1).describe('Duration to extend by (e.g., "24h", "7d")'),
});

export function extendQurlTool(client: IQURLClient) {
  return {
    name: "extend_qurl",
    title: "Extend qURL Expiration",
    description:
      "Push out the expiration of an active qURL by a relative duration. " +
      "Convenience wrapper for the most common update — equivalent to `update_qurl({ resource_id, extend_by })`. " +
      "Use this when the only change you need is more time on the clock. " +
      "Use `update_qurl` instead when you also need to change tags, description, or set an absolute `expires_at`. " +
      "Use `delete_qurl` when you want to cut off access entirely. " +
      "Accepts both `r_` and `q_` IDs (q_ is auto-resolved to its parent resource). " +
      "Returns the updated resource with the new `expires_at` (same shape as `get_qurl`).",
    inputSchema: extendQurlSchema,
    outputSchema: extendQurlOutputSchema,
    annotations: {
      title: "Extend qURL Expiration",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof extendQurlSchema>) => {
      const result = await client.extendQURL(input.resource_id, {
        extend_by: input.extend_by,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data),
          },
        ],
        structuredContent: result.data as unknown as Record<string, unknown>,
      };
    }),
  };
}
