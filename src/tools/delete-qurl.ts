import { z } from "zod";
import type { IQURLClient } from "../client.js";

export const deleteQurlSchema = z.object({
  // DELETE only accepts r_ (resource) IDs per the API spec — unlike
  // get/update/extend/mint_link which also accept q_ prefixes. Reject
  // non-r_ IDs at the schema boundary so agents get a clear error
  // instead of a confusing API-side rejection.
  resource_id: z
    .string()
    .min(1)
    .startsWith("r_", "delete_qurl only accepts resource IDs (r_ prefix). Use update_qurl or mint_link for q_ IDs.")
    .describe(
      "The resource ID (must start with r_). delete_qurl does not accept q_ (QURL display) IDs.",
    ),
});

export function deleteQurlTool(client: IQURLClient) {
  return {
    name: "delete_qurl",
    description: "Revoke/delete a QURL. This immediately invalidates the link.",
    inputSchema: deleteQurlSchema,
    handler: async (input: z.infer<typeof deleteQurlSchema>) => {
      await client.deleteQURL(input.resource_id);
      return {
        content: [
          {
            type: "text" as const,
            text: `QURL ${input.resource_id} has been revoked.`,
          },
        ],
      };
    },
  };
}
