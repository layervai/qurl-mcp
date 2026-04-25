import { z } from "zod";
import type { IQURLClient } from "../client.js";

export const listQurlsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of qURLs to return (default: 20)"),
  cursor: z.string().optional().describe("Pagination cursor from a previous response"),
  // Plain string (not z.enum) because the API accepts comma-separated values like "active,revoked"
  status: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by status (comma-separated, e.g., 'active,revoked')"),
  created_after: z.string().datetime().optional().describe("Filter: created after this date (RFC 3339)"),
  created_before: z.string().datetime().optional().describe("Filter: created before this date (RFC 3339)"),
  expires_before: z.string().datetime().optional().describe("Filter: expires before this date (RFC 3339)"),
  expires_after: z.string().datetime().optional().describe("Filter: expires after this date (RFC 3339)"),
  sort: z
    .string()
    .regex(
      /^(created_at|expires_at)(:(asc|desc))?$/,
      "sort must be 'created_at' or 'expires_at', optionally followed by ':asc' or ':desc'",
    )
    .optional()
    .describe(
      "Sort field and direction as 'field:direction'. " +
        "Valid fields: created_at, expires_at. Valid directions: asc, desc (default desc). " +
        "Example: 'created_at:desc'.",
    ),
  q: z
    .string()
    .min(1)
    .optional()
    .describe("Search query (searches description and target_url)"),
});

export function listQurlsTool(client: IQURLClient) {
  return {
    name: "list_qurls",
    description:
      "List qURLs with optional filtering by status, date ranges, and search query.",
    inputSchema: listQurlsSchema,
    handler: async (input: z.infer<typeof listQurlsSchema>) => {
      const result = await client.listQURLs(input);
      return {
        content: [
          {
            type: "text" as const,
            // Full result (not .data) — includes meta.next_cursor for pagination
            text: JSON.stringify(result),
          },
        ],
      };
    },
  };
}
