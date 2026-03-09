import { z } from "zod";
import type { QURLClient } from "../client.js";

export const getQurlSchema = z.object({
  resource_id: z.string().describe("The resource ID (e.g., r_a3x9Bk7mQ2)"),
});

export function getQurlTool(client: QURLClient) {
  return {
    name: "get_qurl",
    description: "Get details of a specific QURL by its resource ID.",
    inputSchema: getQurlSchema,
    handler: async (input: z.infer<typeof getQurlSchema>) => {
      const result = await client.getQURL(input.resource_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    },
  };
}
