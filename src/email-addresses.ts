import { z } from "zod";
import { domainToASCII } from "node:url";

export function normalizeEmailDomain(value: string): string {
  const normalized = value.trim().normalize("NFC").toLowerCase().replace(/\.$/, "");
  const ascii = domainToASCII(normalized);
  // Node returns an empty string for IDNA-invalid input. Preserve that input
  // so the caller's email/domain validator rejects it explicitly instead of
  // silently turning an address such as "a@[invalid]" into "a@".
  return ascii || normalized;
}

export function normalizeEmailAddress(value: string): string {
  // This is a total canonicalizer for deduplication, not a validator. Invalid
  // input is returned in normalized form so callers can report it consistently;
  // delivery/config boundaries pair it with isEmailAddress before use.
  const normalized = value.trim().normalize("NFC");
  const separator = normalized.lastIndexOf("@");
  if (separator < 1) return normalized.toLowerCase();
  const localPart = normalized.slice(0, separator).toLowerCase();
  const domain = normalizeEmailDomain(normalized.slice(separator + 1));
  return `${localPart}@${domain}`;
}

export const normalizedEmailAddressSchema = z
  .string()
  .transform(normalizeEmailAddress)
  .pipe(z.email());

export function isEmailAddress(value: string): boolean {
  return normalizedEmailAddressSchema.safeParse(value).success;
}

export function uniqueRecipients(recipients: string[]): string[] {
  // SMTP local parts are technically case-sensitive, but modern providers
  // treat addresses case-insensitively. Canonicalizing the full address keeps
  // allowlist and per-principal quota behavior consistent.
  return Array.from(
    new Set(recipients.map(normalizeEmailAddress).filter((recipient) => recipient.length > 0)),
  );
}
