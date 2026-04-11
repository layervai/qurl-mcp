import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { createQurlSchema } from "./create-qurl.js";

export const batchCreateSchema = z.object({
  items: z
    .array(createQurlSchema)
    .min(1)
    .max(100)
    .describe("Array of QURL creation requests (1-100 items)"),
});

export function batchCreateTool(client: IQURLClient) {
  return {
    name: "batch_create_qurls",
    description:
      "Create multiple QURLs in a single request. " +
      "Returns per-item results including any errors for partial failures. " +
      "The response sets isError=true when one or more items fail so agents can branch on partial failure without parsing the JSON.",
    inputSchema: batchCreateSchema,
    handler: async (input: z.infer<typeof batchCreateSchema>) => {
      const result = await client.batchCreate(input);
      const payload = {
        ...result.data,
        request_id: result.meta?.request_id,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload),
          },
        ],
        isError: result.data.failed > 0,
      };
    },
  };
}
