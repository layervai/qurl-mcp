import { z } from "zod";
import { type IQURLClient, QURLAPIError } from "../client.js";
import {
  resourceOnlyIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { terminateQurlSessionsOutputSchema } from "./output-schemas.js";

export const terminateQurlSessionsSchema = z.object({
  resource_id: resourceOnlyIdSchema("terminate sessions for"),
  session_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Specific session ID to terminate. Omit to terminate all active sessions for the resource.",
    ),
});

export function terminateQurlSessionsTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "terminate_qurl_sessions",
    title: "Terminate qURL Sessions",
    description:
      "Terminate active access sessions for a qURL resource. " +
      "Use this after shortening access, rotating a link, or responding to a suspected leak when already-open sessions should end immediately. " +
      "Pass `session_id` to terminate one active session; omit it to terminate all active sessions for the resource. " +
      "Use `list_qurl_sessions` first when you need to inspect current sessions before taking action. " +
      "**Side-effects:** existing access sessions are closed; qURL tokens themselves are not revoked.",
    inputSchema: terminateQurlSessionsSchema,
    outputSchema: terminateQurlSessionsOutputSchema,
    annotations: {
      title: "Terminate qURL Sessions",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(
      async (input: z.infer<typeof terminateQurlSessionsSchema>) => {
        if (input.session_id) {
          await client.terminateResourceSession(input.resource_id, input.session_id);
          const payload = {
            resource_id: input.resource_id,
            session_id: input.session_id,
            // The API returns 204 for a single session delete, so the tool
            // synthesizes the count from the successful operation.
            terminated: 1,
            message: `qURL session ${input.session_id} is terminated.`,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
            structuredContent: toStructuredContent(payload),
          };
        }

        const result = await client.terminateAllResourceSessions(input.resource_id);
        const terminated = result.data?.terminated;
        if (typeof terminated !== "number") {
          throw new QURLAPIError(
            502,
            "invalid_response",
            "qURL API returned an invalid session termination response.",
          );
        }

        const payload = {
          resource_id: input.resource_id,
          terminated,
          message: `Terminated ${terminated} qURL session(s).`,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: toStructuredContent(payload),
        };
      },
    ),
  };
}
