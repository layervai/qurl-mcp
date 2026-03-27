import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { accessPolicySchema } from "./create-qurl.js";

export const mintLinkBaseSchema = z.object({
  resource_id: z.string().describe("The resource ID to mint a new access link for"),
  label: z.string().optional().describe("Human-readable label identifying who this link is for"),
  expires_in: z.string().optional().describe('Relative duration until expiration (e.g., "5m", "24h", "7d"). Mutually exclusive with expires_at'),
  expires_at: z.string().datetime().optional().describe("Absolute expiration timestamp (RFC 3339). Mutually exclusive with expires_in"),
  one_time_use: z.boolean().optional().describe("Whether this link can only be used once"),
  max_sessions: z.number().int().min(0).optional().describe("Maximum concurrent sessions (0 = unlimited)"),
  session_duration: z.string().optional().describe('How long access lasts after clicking (e.g., "1h")'),
  access_policy: accessPolicySchema.optional().describe("Access control policy for this link"),
});

export const mintLinkSchema = mintLinkBaseSchema.refine(
  (data) => !(data.expires_in && data.expires_at),
  { message: "Provide either expires_in or expires_at, not both" },
);

export function mintLinkTool(client: IQURLClient) {
  return {
    name: "mint_link",
    description:
      "Mint a new access link for an existing QURL resource. " +
      "Use this to generate additional access links without creating a new resource.",
    inputSchema: mintLinkBaseSchema,
    handler: async (raw: z.infer<typeof mintLinkBaseSchema>) => {
      const input = mintLinkSchema.parse(raw);
      const { resource_id, ...body } = input;
      const result = await client.mintLink(resource_id, body);
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
