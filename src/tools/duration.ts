import { z } from "zod";

// Accepts a safe subset of qurl-service's duration grammar (no sign, leading
// dot, or U+03BC mu): whole days/weeks ("7d", "1w") or a
// Go duration ("30m", "1h30m", "1.5h"). Each repetition must end in a unit,
// so matching is linear; durationSchema's .max(32) bounds the input as well.
const DURATION_PATTERN = /^(?:\d+[dw]|(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+)$/;
// Nanoseconds per unit, so sub-millisecond units sum exactly before one division.
const GO_DURATION_UNIT_NS = {
  ns: 1,
  us: 1e3,
  µs: 1e3,
  ms: 1e6,
  s: 1e9,
  m: 6e10,
  h: 3.6e12,
} as const;

/**
 * Milliseconds in a duration string, or undefined when the grammar rejects it.
 * Fractions are Go-duration only ("1.5h"); whole days/weeks are integers
 * ("1.5d" is rejected), matching ParseDuration's strconv.Atoi branch.
 */
export function parseDurationMs(value: string): number | undefined {
  if (!DURATION_PATTERN.test(value)) return undefined;
  const whole = /^(\d+)([dw])$/.exec(value);
  if (whole) return Number(whole[1]) * (whole[2] === "d" ? 86_400_000 : 604_800_000);
  let totalNs = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    totalNs += Number(amount) * GO_DURATION_UNIT_NS[unit as keyof typeof GO_DURATION_UNIT_NS];
  }
  return totalNs / 1e6;
}

// Bounds mirror qurl-service so an out-of-range value fails before any side
// effect (for uploads, before the file is stored). Keep in sync with
// internal/api/validation/constants.go (MinExpirationDuration,
// MaxSessionDuration) and internal/domain/qurl.go (MaxCustomerExpiryDuration);
// the grammar mirrors internal/domain/duration.go (ParseDuration).
// Grammar and range fail with different messages so a caller retrying knows
// whether to fix the syntax or the size. create_qurl and mint_link still defer
// their durations to the API; tracked with the drift guard in #282.
// allowEmpty lets "" through as its own value (a z.union would collapse both
// messages into a generic "Invalid input").
export const durationSchema = (minMs: number, maxMs: number, range: string, allowEmpty = false) =>
  z
    .string()
    .min(allowEmpty ? 0 : 1)
    .max(32)
    .refine((value) => (allowEmpty && value === "") || parseDurationMs(value) !== undefined, {
      message: "Use a duration like '30m', '24h', or '7d'",
      abort: true,
    })
    .refine(
      (value) => {
        if (allowEmpty && value === "") return true;
        const ms = parseDurationMs(value) ?? 0;
        return ms >= minMs && ms <= maxMs;
      },
      { message: `Duration must be ${range}` },
    );

// validation.MinExpirationDuration and domain.MaxCustomerExpiryDuration; qurl-service
// applies the same pair to expires_in and extend_by (ValidateDuration). Upload
// links take them too: the connector forwards the requested expiry to
// qurl-service's mint, which enforces the same ceiling.
export const MIN_EXPIRY_MS = 60_000;
// Global, not per plan: qurl-service's MaxCustomerExpiryDuration is 30d on
// every customer plan (get_quota's max_expiry_seconds reports the same value).
export const MAX_EXPIRY_MS = 30 * 86_400_000;

// MAX_SESSION_MS mirrors validation.MaxSessionDuration (24h). MIN_SESSION_MS is
// an MCP-local floor with no service counterpart: a sub-second session expires
// on arrival.
export const MIN_SESSION_MS = 1_000;
export const MAX_SESSION_MS = 86_400_000;
