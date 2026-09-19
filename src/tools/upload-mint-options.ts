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

const durationSchema = z
  .string()
  .min(1)
  .refine((value) => parseDurationMs(value) !== undefined, {
    message: "Use a duration like '30m', '24h', '7d', or '1w'",
  });

// The file connector mints uploaded-file links, and its mint contract carries
// no access policy or session cap. Reject them before the upload instead of
// silently minting a link without the restriction the caller asked for.
const unsupportedForUploads = (field: string) =>
  z
    .never({ error: `${field} is not supported for uploaded files` })
    .optional()
    .describe(`Not supported for uploaded files; setting ${field} rejects the request.`);

export const uploadMintOptionsShape = {
  label: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Human-readable label for the upload (max 500 chars), used as the document title and in email delivery",
    ),
  expires_in: durationSchema.optional().describe('Link lifetime (e.g., "1h", "24h", "7d")'),
  one_time_use: z
    .boolean()
    .optional()
    .describe("Whether the link can only be used once. Defaults to true for uploaded content."),
  session_duration: durationSchema
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h")'),
  max_sessions: unsupportedForUploads("max_sessions"),
  access_policy: unsupportedForUploads("access_policy"),
};
