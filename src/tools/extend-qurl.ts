import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { resourceIdSchema, withMissingApiKeyHandler } from "./_shared.js";

export const extendQurlSchema = z.object({
  resource_id: resourceIdSchema("extend"),
  extend_by: z.string().min(1).describe('Duration to extend by (e.g., "24h", "7d")'),
});

export function extendQurlTool(client: IQURLClient) {
  return {
    name: "extend_qurl",
    description:
      "Extend the expiration of an active qURL. Accepts a resource ID (r_) or qURL display ID (q_). " +
      "Shorthand for update_qurl with only extend_by — use update_qurl for richer updates (tags, description, expiration).",
    inputSchema: extendQurlSchema,
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
      };
    }),
  };
}
