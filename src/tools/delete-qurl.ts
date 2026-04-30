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
      "**Idempotent:** the API returns 404 for re-deletes, never-existed IDs, and resources owned by another API key (ownership-mismatch is collapsed into 404 server-side to avoid existence disclosure); this tool swallows all three. " +
      "Branch on `was_already_revoked` to distinguish the no-op case from a successful revoke on this call. " +
      "When the ID came from user input and ownership matters, call `get_qurl` first — a 200 confirms ownership; a thrown 404 is equally ambiguous on that endpoint too. " +
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
      let wasAlreadyRevoked = false;
      try {
        await client.deleteQURL(input.resource_id);
      } catch (err) {
        // Re-delete of an already-revoked (or never-existed) resource:
        // the API returns 404, but the agent's intent ("this resource
        // should not be live") is already satisfied. Swallow the throw
        // so the tool is genuinely idempotent, but expose
        // `was_already_revoked: true` in the payload so defensive
        // agents can branch when they care.
        //
        // Verified against qurl-service: the service-layer
        // `QurlService.RevokeQurl` and `QurlService.GetQurl` both
        // collapse ownership-mismatch into `ErrResourceNotFound` — so
        // 404 covers "you don't own this resource" on both endpoints.
        // The collapse is server-side policy to avoid existence
        // disclosure. The tool description tells callers that
        // `get_qurl` only confirms ownership in the *positive* case
        // (200), since `get_qurl`'s 404 is just as ambiguous as
        // `delete_qurl`'s. (Function names only — line numbers in a
        // separate repo rot on the next refactor; grep
        // `func.*RevokeQurl\b` / `func.*GetQurl\b` in qurl-service.)
        //
        // Intentionally checks status only, not `code`. A 404 with a
        // non-JSON body (e.g. an HTML error page from a proxy in front
        // of the API) lands here as `code: "parse_error"` — the
        // resource still isn't live, so treating it as already-revoked
        // is the right behavior; defensive agents see that via the
        // `was_already_revoked` flag.
        if (!(err instanceof QURLAPIError) || err.statusCode !== 404) throw err;
        wasAlreadyRevoked = true;
      }
      const payload = {
        resource_id: input.resource_id,
        revoked: true as const,
        was_already_revoked: wasAlreadyRevoked,
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
