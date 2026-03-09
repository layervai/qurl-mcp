import { z } from "zod";
import type { QURLClient } from "../client.js";

export const deleteQurlSchema = z.object({
  resource_id: z.string().describe("The resource ID to delete/revoke"),
});

export function deleteQurlTool(client: QURLClient) {
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
