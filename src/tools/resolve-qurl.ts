import { z } from "zod";
import type { IQURLClient } from "../client.js";

export const resolveQurlSchema = z.object({
  access_token: z
    .string()
    .describe("The access token from a QURL link (e.g., at_k8xqp9h2sj9lx7r4a)"),
});

export function resolveQurlTool(client: IQURLClient) {
  return {
    name: "resolve_qurl",
    description:
      "Resolve a QURL access token to get the target URL and open firewall access. " +
      "After resolution, the target URL is accessible from your IP for the duration " +
      "specified in access_grant.expires_in seconds.",
    inputSchema: resolveQurlSchema,
    handler: async (input: z.infer<typeof resolveQurlSchema>) => {
      const result = await client.resolveQURL(input);
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
