import { z } from "zod";
import { type IQURLClient, QURLAPIError } from "../client.js";
import { withMissingApiKeyHandler } from "./_shared.js";
import { deleteQurlOutputSchema } from "./output-schemas.js";

export const deleteQurlSchema = z.object({
  // DELETE only accepts r_ (resource) IDs per the API spec — unlike
  // get/update/extend/mint_link which also accept q_ prefixes. Reject
  // non-r_ IDs at the schema boundary so agents get a clear error
  // instead of a confusing API-side rejection.
  resource_id: z
    .string()
    .min(1)
    .startsWith("r_", "delete_qurl only accepts resource IDs (r_ prefix). Use update_qurl or mint_link for q_ IDs.")
    .describe(
      "The resource ID (must start with r_). delete_qurl does not accept q_ (qURL display) IDs.",
    ),
});

export function deleteQurlTool(client: IQURLClient) {
  return {
    name: "delete_qurl",
    title: "Delete qURL",
    description:
      "Permanently revoke a qURL — the link and every access token under it stop working immediately. " +
      "**This action is irreversible.** Use this when you want to cut off access entirely (compromised link, departed user, end-of-engagement). " +
      "Use `update_qurl` instead when you only need to shorten/extend the expiration, retag, or rename — those preserve the existing access tokens. " +
      "Use `extend_qurl` when you only need to push the expiration out. " +
      "**Idempotent:** re-deletes return success even if the resource was already revoked or never existed — verify with `get_qurl` first if the ID came from user input. " +
      "Returns a confirmation payload. By default the resource is excluded from `list_qurls`; pass `status: \"revoked\"` to see it.",
    inputSchema: deleteQurlSchema,
    outputSchema: deleteQurlOutputSchema,
    annotations: {
      title: "Delete qURL",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof deleteQurlSchema>) => {
      try {
        await client.deleteQURL(input.resource_id);
      } catch (err) {
        // Re-delete of an already-revoked resource: the API returns 404,
        // but the agent's intent ("this resource should not be live") is
        // already satisfied. Swallow it so the tool is genuinely
        // idempotent — matching `annotations.idempotentHint: true`.
        if (!(err instanceof QURLAPIError) || err.statusCode !== 404) throw err;
      }
      const payload = {
        resource_id: input.resource_id,
        revoked: true as const,
        message: `qURL ${input.resource_id} is revoked.`,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: payload.message,
          },
        ],
        structuredContent: payload,
      };
    }),
  };
}
