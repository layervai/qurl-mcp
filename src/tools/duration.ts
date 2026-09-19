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

/**
 * Milliseconds in a duration string, or undefined when the grammar rejects it.
 * Fractions are Go-duration only ("1.5h"); whole days/weeks are integers
 * ("1.5d" is rejected), matching ParseDuration's strconv.Atoi branch.
 */
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

// Bounds mirror qurl-service so an out-of-range value fails before any side
// effect (for uploads, before the file is stored). Keep in sync with
// internal/api/validation/constants.go (MinExpirationDuration,
// MaxSessionDuration) and internal/domain/qurl.go (MaxCustomerExpiryDuration);
// the grammar mirrors internal/domain/duration.go (ParseDuration).
export const durationSchema = (minMs: number, maxMs: number, range: string) =>
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

// validation.MinExpirationDuration and domain.MaxCustomerExpiryDuration; qurl-service
// applies the same pair to expires_in and extend_by (ValidateDuration). Upload
// links take them too: the connector forwards the requested expiry to
// qurl-service's mint, which enforces the same ceiling.
export const MIN_EXPIRY_MS = 60_000;
export const MAX_EXPIRY_MS = 30 * 86_400_000;
