import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { createQurlSchema } from "./create-qurl.js";

const batchItemSchema = createQurlSchema.pick({
  target_url: true,
  label: true,
  expires_in: true,
  one_time_use: true,
  max_sessions: true,
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
