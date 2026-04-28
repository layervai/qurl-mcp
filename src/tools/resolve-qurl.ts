import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import { resolveQurlOutputSchema } from "./output-schemas.js";

export const resolveQurlSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .describe("The access token from a qURL link (e.g., at_k8xqp9h2sj9lx7r4a)"),
});

export function resolveQurlTool(client: IQURLClient) {
  return {
    name: "resolve_qurl",
    title: "Resolve qURL Access Token",
    description:
      "Redeem a qURL access token (the `at_` prefix you pulled out of a `qurl_link`) to reveal the underlying URL and open a time-bound, IP-bound firewall grant. " +
      "Use this when an agent has been handed an access token and needs to fetch the protected resource — after a successful resolve, requests from `access_grant.src_ip` will be permitted to the `target_url` for `access_grant.expires_in` seconds. " +
      "Use `get_qurl` instead when you have a resource ID (`r_`) or qURL display ID (`q_`) and want admin-side details rather than end-user redemption. " +
      "**Side-effects:** consumes one use on `one_time_use` tokens, decrements `max_sessions`, and may trip access policies (IP/geo/UA/AI-agent denylists). " +
      "**`idempotentHint: false`** because one-time-use tokens consume on each call; for non-one-time tokens within an active grant window, repeats are effectively no-ops, but the conservative annotation reflects worst-case behavior.",
    inputSchema: resolveQurlSchema,
    outputSchema: resolveQurlOutputSchema,
    annotations: {
      title: "Resolve qURL Access Token",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof resolveQurlSchema>) => {
      const result = await client.resolveQURL(input);
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
