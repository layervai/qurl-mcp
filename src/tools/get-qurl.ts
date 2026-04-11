import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { describeResourceIdParam } from "./_shared.js";

export const getQurlSchema = z.object({
  resource_id: z.string().describe(describeResourceIdParam("fetch")),
});

export function getQurlTool(client: IQURLClient) {
  return {
    name: "get_qurl",
    description:
      "Get details of a QURL resource and its access tokens. " +
      "Accepts either a resource ID (r_ prefix) or a QURL display ID (q_ prefix).",
    inputSchema: getQurlSchema,
    handler: async (input: z.infer<typeof getQurlSchema>) => {
      const result = await client.getQURL(input.resource_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data),
          },
        ],
      };
    },
  };
}
