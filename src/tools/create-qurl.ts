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
  ip_allowlist: z
    .array(z.string())
    .optional()
    .describe("Allowed IP addresses or CIDR ranges"),
  ip_denylist: z
    .array(z.string())
    .optional()
    .describe("Denied IP addresses or CIDR ranges"),
  geo_allowlist: z
    .array(z.string())
    .optional()
    .describe("Allowed country codes (ISO 3166-1 alpha-2)"),
  geo_denylist: z
    .array(z.string())
    .optional()
    .describe("Denied country codes (ISO 3166-1 alpha-2)"),
  user_agent_allow_regex: z
    .string()
    .optional()
    .describe("Regex to allow matching user agents"),
  user_agent_deny_regex: z
    .string()
    .optional()
    .describe("Regex to deny matching user agents"),
  ai_agent_policy: aiAgentPolicySchema.optional().describe("Structured AI agent access control"),
});

export const createQurlSchema = z.object({
  target_url: z.string().url().describe("The URL to protect with qURL"),
  label: z
    .string()
    .max(500)
    .optional()
    .describe("Human-readable label identifying who this qURL is for (max 500 chars)"),
  expires_in: z
    .string()
    .min(1)
    .optional()
    .describe('Duration string (e.g., "1h", "24h", "7d")'),
  one_time_use: z.boolean().optional().describe("Whether the link can only be used once"),
  max_sessions: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Maximum concurrent sessions (0 = unlimited, max 1000)"),
  session_duration: z
    .string()
    .min(1)
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h")'),
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
      "Create a new qURL — a policy-bound, expiring access link to a protected target URL. " +
      "Use this when an agent needs to mint a fresh resource (e.g. share-once link, time-limited access). " +
      "Use `mint_link` instead when you already have a resource and only need an additional access link. " +
      "Use `batch_create_qurls` to create many in one call. " +
      "Returns the new resource ID and a `qurl_link` that is shown ONCE and never returned by `get_qurl` or `list_qurls` — share it immediately.",
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
