import { z } from "zod";
import type { QURLClient } from "../client.js";

export const listQurlsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of QURLs to return (default: 20)"),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous response"),
});

export function listQurlsTool(client: QURLClient) {
  return {
    name: "list_qurls",
    description: "List active QURLs with optional pagination.",
    inputSchema: listQurlsSchema,
    handler: async (input: z.infer<typeof listQurlsSchema>) => {
      const result = await client.listQURLs(input);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  };
}
