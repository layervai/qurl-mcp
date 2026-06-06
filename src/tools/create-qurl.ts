import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import { createQurlOutputSchema } from "./output-schemas.js";

export const aiAgentPolicySchema = z.object({
  block_all: z.boolean().optional().describe("Block all recognized AI agents"),
  deny_categories: z
    .array(z.string())
    .optional()
    .describe("AI agent categories to block (e.g., gptbot, commoncrawl)"),
  allow_categories: z
    .array(z.string())
    .optional()
    .describe("AI agent categories to permit (all others blocked)"),
});

export const accessPolicySchema = z.object({
  ip_allowlist: z.array(z.string()).optional().describe("Allowed IP addresses or CIDR ranges"),
  ip_denylist: z.array(z.string()).optional().describe("Denied IP addresses or CIDR ranges"),
  geo_allowlist: z
    .array(z.string())
    .optional()
    .describe("Allowed country codes (ISO 3166-1 alpha-2)"),
  geo_denylist: z
    .array(z.string())
    .optional()
    .describe("Denied country codes (ISO 3166-1 alpha-2)"),
  user_agent_allow_regex: z.string().optional().describe("Regex to allow matching user agents"),
  user_agent_deny_regex: z.string().optional().describe("Regex to deny matching user agents"),
  ai_agent_policy: aiAgentPolicySchema.optional().describe("Structured AI agent access control"),
});

export const createQurlSchema = z.object({
  type: z
    .string()
    .optional()
    .describe("Resource type for integrations allowed to mint non-url qURLs. Defaults to url."),
  target_url: z.string().url().describe("The URL to protect with qURL"),
  label: z
    .string()
    .max(500)
    .optional()
    .describe("Human-readable label identifying who this qURL is for (max 500 chars)"),
  expires_in: z.string().min(1).optional().describe('Duration string (e.g., "1h", "24h", "7d")'),
  one_time_use: z.boolean().optional().describe("Whether the link can only be used once"),
  max_sessions: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "Maximum concurrent sessions for this qURL token (0 = unlimited when one_time_use is explicitly false; max 1000)",
    ),
  session_duration: z
    .string()
    .min(1)
    .optional()
    .describe(
      'How long access lasts after the recipient reaches the content (e.g., "1h"). ' +
        "This anchors the resource-level session-duration cap when a new resource is created.",
    ),
  custom_domain: z
    .string()
    .max(253)
    .optional()
    .describe(
      "Custom domain to assign to the auto-created resource (max 253 chars, must be registered/active/owned).",
    ),
  access_policy: accessPolicySchema.optional().describe("Access control policy for the qURL"),
});

export function createQurlTool(client: IQURLClient) {
  return {
    name: "create_qurl",
    title: "Create qURL",
    description:
      "Create a qURL — a policy-bound, expiring access link that gates a target URL with optional IP/geo/UA/AI-agent filters and time or session limits. " +
      "**When to use:** minting a fresh protected access link for share-once or time-limited access (e.g. send a customer a 24-hour download link, gate a doc behind an IP allowlist, distribute a one-time-use credential to a contractor). " +
      "**When NOT to use:** use `mint_link` when you already have a resource (`r_…`) and just need an additional access token under it — `create_qurl` identifies the resource by target URL and may return an existing same-type resource grouping. " +
      "Use `batch_create_qurls` to create many in one round-trip. " +
      "Use `update_qurl` to retag or extend an existing resource without minting a new one. " +
      "**Behavior:** not idempotent — calling twice produces two distinct qURL tokens, though both may share the same `resource_id` when the target URL groups to an existing same-type resource (this tool doesn't surface the underlying API's `Idempotency-Key` header). " +
      "The returned `qurl_link` is shown ONCE in this response and is never recoverable through `get_qurl` or `list_qurls`; persist or share it immediately. " +
      "A returned resource is in `active` status with the policy and per-token limits applied. " +
      "If `expires_in` is omitted the API defaults to **24h** — do not assume the link is permanent. " +
      "`max_sessions` is per minted qURL, not resource-wide; set `one_time_use: false` explicitly when you need `max_sessions: 0` to mean unlimited visitors. " +
      "**Returns:** `{ qurl_id: string (q_…), resource_id: string (r_…), qurl_link: string (shown once), branded_domain?: string, qurl_site: string, expires_at: string (RFC 3339), label?: string, type?: string }`. " +
      "`qurl_id` is the only `q_…` display ID an agent gets in this response — keep it if you plan a follow-up against `get_qurl`/`update_qurl`/`mint_link` (which accept either prefix). " +
      "Example: `create_qurl({ target_url: 'https://example.com/private', expires_in: '24h', one_time_use: true, access_policy: { geo_allowlist: ['US'] } })`.",
    inputSchema: createQurlSchema,
    outputSchema: createQurlOutputSchema,
    annotations: {
      title: "Create qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof createQurlSchema>) => {
      const result = await client.createQURL(input);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.data),
          },
        ],
        structuredContent: toStructuredContent(result.data),
      };
    }),
  };
}
