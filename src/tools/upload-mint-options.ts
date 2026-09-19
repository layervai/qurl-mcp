import { z } from "zod";

// Mirrors qurl-service's duration grammar: whole days/weeks ("7d", "1w") or a
// Go duration ("30m", "1h30m", "1.5h").
const DURATION_PATTERN = /^(?:\d+[dw]|(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+)$/;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** Milliseconds in a duration string, or undefined when the grammar rejects it. */
export function parseDurationMs(value: string): number | undefined {
  if (!DURATION_PATTERN.test(value)) return undefined;
  const whole = /^(\d+)([dw])$/.exec(value);
  if (whole) return Number(whole[1]) * (whole[2] === "d" ? 86_400_000 : 604_800_000);
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(amount) * GO_DURATION_UNIT_MS[unit];
  }
  return total;
}

// Bounds mirror qurl-service so an out-of-range value fails before the upload
// stores the file, not at mint time after it. Keep in sync with
// internal/api/validation/constants.go (MinExpirationDuration,
// MaxSessionDuration) and internal/domain/qurl.go (MaxCustomerExpiryDuration);
// the grammar mirrors internal/domain/duration.go (ParseDuration).
const durationSchema = (minMs: number, maxMs: number, range: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => {
        const ms = parseDurationMs(value);
        return ms !== undefined && ms >= minMs && ms <= maxMs;
      },
      { message: `Use a duration like '30m', '24h', or '7d' (${range})` },
    );

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
  label: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Human-readable label (max 500 chars) shown in email delivery and used as the PDF title by upload_text_qurl. It is not attached to the minted link, so the link cannot be found by label afterward.",
    ),
  expires_in: durationSchema(60_000, 30 * 86_400_000, "1m to 30d")
    .optional()
    .describe(
      'Link lifetime (e.g., "1h", "24h", "7d"; max 30d), converted to an absolute expiry using this server\'s clock',
    ),
  one_time_use: z
    .boolean()
    .optional()
    .describe("Whether the link can only be used once. Defaults to true for uploaded content."),
  session_duration: durationSchema(1, 86_400_000, "up to 24h")
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h"; max 24h)'),
  max_sessions: unsupportedForUploads("max_sessions"),
  access_policy: unsupportedForUploads("access_policy"),
};

export type UploadMintOptionsInput = z.infer<z.ZodObject<typeof uploadMintOptionsShape>>;
