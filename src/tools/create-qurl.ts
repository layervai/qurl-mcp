import { z } from "zod";
import type { IQURLClient } from "../client.js";

export const createQurlSchema = z.object({
  target_url: z.string().url().describe("The URL to protect with QURL"),
  description: z.string().optional().describe("Human-readable description"),
  expires_in: z.string().optional().describe('Duration string (e.g., "1h", "24h", "168h")'),
  one_time_use: z.boolean().optional().describe("Whether the link can only be used once"),
  max_sessions: z.number().int().positive().optional().describe("Maximum concurrent sessions"),
  metadata: z.record(z.unknown()).optional().describe("Custom metadata key-value pairs"),
});

export function createQurlTool(client: IQURLClient) {
  return {
    name: "create_qurl",
    description:
      "Create a QURL - a secure, policy-bound link to a protected resource. " +
      "The returned qurl_link can be shared with users or resolved programmatically.",
    inputSchema: createQurlSchema,
    handler: async (input: z.infer<typeof createQurlSchema>) => {
      const result = await client.createQURL(input);
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
