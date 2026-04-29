import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import { listQurlsOutputSchema } from "./output-schemas.js";

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
    title: "List qURLs",
    description:
      "List qURL resources, paginated and optionally filtered by status, date range, or search text. " +
      "**When to use:** discovery — finding qURLs by status (e.g. everything still active), auditing date ranges, or full-text search across descriptions and target URLs (via the `q` parameter). " +
      "Filters AND together (e.g. `status: 'active'` + `expires_before: '2026-05-01T00:00:00Z'` returns active qURLs about to expire). " +
      "**When NOT to use:** use `get_qurl` instead when you already have a specific resource ID — it returns the same per-resource shape more cheaply and includes the `qurls[]` per-token detail that `list_qurls` omits. " +
      "Use `resolve_qurl` to actually open access to a target URL. " +
      "**Behavior:** read-only and idempotent. " +
      "An empty `data[]` with `meta.has_more: false` means no resource matched the filters (not an error). " +
      "Pagination is cursor-based: when `meta.has_more` is `true`, pass `meta.next_cursor` as `cursor` on the next call to fetch the following page. " +
      "Default page size is 20, configurable via `limit` up to 100. " +
      "By default only `active` qURLs are returned; pass `status: 'revoked'` to see only revoked qURLs or `'active,revoked'` to see both. " +
      // The default-active and default-sort-field claims are asserted from
      // current API behavior; the spec only pins the sort *direction*
      // default. See issue #99 for spec/staging pinning. The description
      // intentionally drops the epistemics caveat — overhedging in
      // LLM-facing prose invites defensive over-specification on every call.
      "Sort defaults to `created_at:desc`; override with `sort: 'expires_at:asc'` etc. " +
      "**Returns:** `{ data: QURL[], meta: { has_more: boolean, next_cursor?: string, page_size?: number, request_id?: string } }` — each `data[]` item is the same stable resource shape returned by `get_qurl` minus per-token detail. " +
      'Example: `list_qurls({ status: "active", sort: "expires_at:asc", limit: 10 })` returns the 10 active qURLs expiring soonest.',
    inputSchema: listQurlsSchema,
    outputSchema: listQurlsOutputSchema,
    annotations: {
      title: "List qURLs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof listQurlsSchema>) => {
      const result = await client.listQURLs(input);
      return {
        content: [
          {
            type: "text" as const,
            // Full result (not .data) — includes meta.next_cursor for pagination
            text: JSON.stringify(result),
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }),
  };
}
