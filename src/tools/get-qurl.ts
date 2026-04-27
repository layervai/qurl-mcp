import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { resourceIdSchema, withMissingApiKeyHandler } from "./_shared.js";
import { getQurlOutputSchema } from "./output-schemas.js";

export const getQurlSchema = z.object({
  resource_id: resourceIdSchema("fetch"),
});

export function getQurlTool(client: IQURLClient) {
  return {
    name: "get_qurl",
    title: "Get qURL",
    description:
      "Fetch a single qURL resource by ID and return its current state plus all access tokens. " +
      "Use this when you have a specific resource ID (r_ prefix) or qURL display ID (q_ prefix) — q_ IDs are auto-resolved to their parent resource. " +
      "Use `list_qurls` instead when you need to discover qURLs by status, date range, or search query. " +
      "Use `resolve_qurl` instead when you have an end-user access token (at_ prefix) and need to redeem it for the underlying URL. " +
      "Returns the resource shape with embedded `qurls[]` (per-token state); the one-shot `qurl_link` from creation is never returned here.",
    inputSchema: getQurlSchema,
    outputSchema: getQurlOutputSchema,
    annotations: {
      title: "Get qURL",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof getQurlSchema>) => {
      const result = await client.getQURL(input.resource_id);
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
