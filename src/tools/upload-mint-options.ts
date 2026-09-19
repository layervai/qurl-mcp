import { z } from "zod";
import {
  durationSchema,
  MAX_EXPIRY_MS,
  MAX_SESSION_MS,
  MIN_EXPIRY_MS,
  MIN_SESSION_MS,
  parseDurationMs,
} from "./duration.js";

// The file connector mints uploaded-file links, and its mint contract carries
// no access policy or session cap. Reject them before the upload instead of
// silently minting a link without the restriction the caller asked for.
// This guards the two named options only; the schema is not strict, so other
// unknown keys are still stripped, as for every tool.
// z.null() emits a portable {"type":"null"} that advertises "no value here";
// `not` (from z.never) is dropped or rejected by some non-TypeScript hosts.
// null itself is tolerated: some hosts serialize unused optional fields that way.
const unsupportedForUploads = (field: string) =>
  z
    .null({ error: `${field} is not supported for uploaded files` })
    .optional()
    .describe(`Not supported for uploaded files; setting ${field} rejects the request.`);

// Upload links cannot be revoked from this server (#281), so their lifetime is
// never left to the connector's default.
export const DEFAULT_UPLOAD_EXPIRES_IN = "24h";

export const uploadMintOptionsShape = {
  // label is not a restriction, so unlike access_policy/max_sessions it is kept:
  // it still drives the email and the text-PDF title, only not the link.
  label: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Used only in email delivery and as upload_text_qurl's PDF title (max 500 chars); without email_delivery it has no effect on file uploads. It is not attached to the minted link, so the link cannot be found by label afterward.",
    ),
  expires_in: durationSchema(MIN_EXPIRY_MS, MAX_EXPIRY_MS, "1m to 30d")
    .optional()
    .describe(
      `Link lifetime (e.g., "1h", "24h", "7d"; max 30d; default ${DEFAULT_UPLOAD_EXPIRES_IN}), converted to an absolute expiry using this server's clock`,
    ),
  one_time_use: z
    .boolean()
    .optional()
    .describe("Whether the link can only be used once. Defaults to true for uploaded content."),
  session_duration: durationSchema(MIN_SESSION_MS, MAX_SESSION_MS, "1s to 24h")
    .refine((value) => (parseDurationMs(value) ?? 0) % 1000 === 0, {
      message: "Uploaded-file session_duration must be a whole number of seconds",
    })
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h"; whole seconds, max 24h)'),
  max_sessions: unsupportedForUploads("max_sessions"),
  access_policy: unsupportedForUploads("access_policy"),
};

export const uploadMintOptionsSchema = z.object(uploadMintOptionsShape);
export type UploadMintOptionsInput = z.infer<typeof uploadMintOptionsSchema>;

// Shared by the three upload tools so their descriptions cannot drift apart.
export const UPLOAD_LINK_DESCRIPTION =
  "Uploaded-file links support `expires_in`, `one_time_use`, and `session_duration`; `access_policy` and `max_sessions` are rejected. **Revocation:** a link created here cannot be revoked from this server; `delete_qurl` on the returned `resource_id` does not stop it (revocation needs the connector's `/api/revoke_links`). Use a short `expires_in` and `one_time_use` for sensitive files. `one_time_use` defaults to `true`, so set it to `false` when emailing the link to more than one recipient. `label` names the email and PDF only; it is not attached to the link, so `list_qurls` cannot find the link by it. ";
export const UPLOAD_RETURNS_DESCRIPTION =
  "**Returns:** `{ resource_id: string, qurl_id?: string, qurl_link: string, expires_at?: string, requested_expires_at?: string, expires_at_differs_from_request?: boolean, expires_at_later_than_requested?: boolean, expires_at_already_past?: boolean, expires_at_unconfirmed?: boolean, unexpected_extra_link_count?: number, unexpected_extra_qurl_ids?: string[], file_name: string, content_type: string, size_bytes: number, email_delivery?: object }`. If `unexpected_extra_link_count` is present, the connector minted extra live links: tell the user (`unexpected_extra_qurl_ids` lists at most 10 of them, so it may be incomplete). If `expires_at_differs_from_request` is set, tell the user the actual `expires_at` (and stress it when `expires_at_later_than_requested` is set, since the link outlives the request); if `expires_at_already_past` is set, warn that the link may already be dead; if `expires_at_unconfirmed` is set, say the link's lifetime is unknown.";
