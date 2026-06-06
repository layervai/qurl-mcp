import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { resourceOnlyIdSchema, toStructuredContent, withMissingApiKeyHandler } from "./_shared.js";
import { listQurlSessionsOutputSchema } from "./output-schemas.js";

export const listQurlSessionsSchema = z.object({
  resource_id: resourceOnlyIdSchema("list active sessions for"),
});

export function listQurlSessionsTool(client: IQURLClient) {
  return {
    name: "list_qurl_sessions",
    title: "List qURL Sessions",
    description:
      "List active access sessions for a qURL resource. " +
      "Use this to inspect who currently has live access before rotating, revoking, or terminating sessions. " +
      "Use `terminate_qurl_sessions` when active sessions should be ended, and use `get_qurl` when you need token/resource metadata instead of active session state. " +
      "**Behavior:** read-only and idempotent. Empty `data[]` means no active sessions for the resource.",
    inputSchema: listQurlSessionsSchema,
    outputSchema: listQurlSessionsOutputSchema,
    annotations: {
      title: "List qURL Sessions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof listQurlSessionsSchema>) => {
      const result = await client.listResourceSessions(input.resource_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: toStructuredContent(result),
      };
    }),
  };
}
