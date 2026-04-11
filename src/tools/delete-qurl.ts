import { z } from "zod";
import type { IQURLClient } from "../client.js";

export const deleteQurlSchema = z.object({
  // DELETE only accepts r_ (resource) IDs per the API spec — unlike
  // get/update/extend/mint_link which also accept q_ prefixes.
  resource_id: z.string().min(1).describe("The resource ID (r_ prefix) to delete/revoke"),
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
