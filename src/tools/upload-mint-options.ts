import { z } from "zod";
import { durationSchema, MAX_EXPIRY_MS, MIN_EXPIRY_MS } from "./duration.js";

// The file connector mints uploaded-file links, and its mint contract carries
// no access policy or session cap. Reject them before the upload instead of
// silently minting a link without the restriction the caller asked for.
// z.unknown() emits a plain `{}` JSON Schema, which every host accepts; `not`
// (from z.never) is dropped or rejected by some non-TypeScript hosts.
const unsupportedForUploads = (field: string) =>
  z
    .unknown()
    .refine((value) => value === undefined, {
      message: `${field} is not supported for uploaded files`,
    })
    .optional()
    .describe(`Not supported for uploaded files; setting ${field} rejects the request.`);

export const uploadMintOptionsShape = {
  // label is not a restriction, so unlike access_policy/max_sessions it is kept:
  // it still drives the email and the text-PDF title, only not the link.
  label: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Human-readable label (max 500 chars) shown in email delivery and used as the PDF title by upload_text_qurl. It is not attached to the minted link, so the link cannot be found by label afterward.",
    ),
  expires_in: durationSchema(MIN_EXPIRY_MS, MAX_EXPIRY_MS, "1m to 30d")
    .optional()
    .describe(
      'Link lifetime (e.g., "1h", "24h", "7d"; max 30d), converted to an absolute expiry using this server\'s clock',
    ),
  one_time_use: z
    .boolean()
    .optional()
    .describe("Whether the link can only be used once. Defaults to true for uploaded content."),
  session_duration: durationSchema(1_000, 86_400_000, "1s to 24h")
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h"; max 24h)'),
  max_sessions: unsupportedForUploads("max_sessions"),
  access_policy: unsupportedForUploads("access_policy"),
};

export type UploadMintOptionsInput = z.infer<z.ZodObject<typeof uploadMintOptionsShape>>;
