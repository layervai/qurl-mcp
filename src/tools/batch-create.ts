import { z } from "zod";
import type { IQURLClient } from "../client.js";

const batchItemSchema = z.object({
  target_url: z.string().url().describe("The URL to protect with QURL"),
  label: z.string().optional().describe("Human-readable label identifying who this QURL is for"),
  expires_in: z.string().optional().describe('Duration string (e.g., "1h", "24h", "7d")'),
  one_time_use: z.boolean().optional().describe("Whether the link can only be used once"),
  max_sessions: z.number().int().min(0).optional().describe("Maximum concurrent sessions (0 = unlimited)"),
});

export const batchCreateSchema = z.object({
  items: z
    .array(batchItemSchema)
    .min(1)
    .max(20)
    .describe("Array of QURL creation requests (1-20 items)"),
});

export function batchCreateTool(client: IQURLClient) {
  return {
    name: "batch_create_qurls",
    description:
      "Create multiple QURLs in a single request. " +
      "Returns per-item results including any errors for partial failures.",
    inputSchema: batchCreateSchema,
    handler: async (input: z.infer<typeof batchCreateSchema>) => {
      const result = await client.batchCreate(input);
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
