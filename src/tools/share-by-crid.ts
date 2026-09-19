import { z } from "zod";
import type { IQURLClient } from "../client.js";
import {
  toStructuredContent,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { shareByCRIDOutputSchema } from "./output-schemas.js";

export const shareByCRIDSchema = z.object({
  crid: z
    .string()
    .min(1)
    .max(512)
    .describe(
      'CRID of the resource to turn into a temporary qURL link. Accepts either the bare CRID or the user-facing "$<CRID>" form.',
    ),
  ttl: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Requested link lifetime in Go duration format, such as "90s", "5m", or "1h30m". The total must be a positive whole number of seconds. The service may adjust the lifetime.',
    ),
});

const DURATION_PART = /(\d+(?:\.\d*)?|\.\d+)(ms|us|µs|μs|ns|h|m|s)/gy;
const UNIT_NANOSECONDS: Record<string, bigint> = {
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  µs: 1_000n,
  μs: 1_000n,
  ns: 1n,
};

function parseTTLSeconds(ttl: string): number | undefined {
  let offset = ttl.startsWith("+") ? 1 : 0;
  let nanoseconds = 0n;

  while (offset < ttl.length) {
    DURATION_PART.lastIndex = offset;
    const part = DURATION_PART.exec(ttl);
    if (!part) return undefined;
    const [whole, fraction = ""] = part[1].split(".");
    // Go durations truncate each component to nanoseconds. Integer arithmetic
    // avoids rejecting whole-second sums because of floating-point rounding.
    nanoseconds +=
      (BigInt(whole + fraction) * UNIT_NANOSECONDS[part[2]]) / 10n ** BigInt(fraction.length);
    offset = DURATION_PART.lastIndex;
  }

  return nanoseconds > 0n &&
    nanoseconds <= 9_223_372_036_854_775_807n &&
    nanoseconds % 1_000_000_000n === 0n
    ? Number(nanoseconds / 1_000_000_000n)
    : undefined;
}

function normalizeCRID(crid: string): string | undefined {
  const trimmed = crid.trim();
  const normalized = trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed;
  return normalized || undefined;
}

/**
 * Request a temporary qURL link for a resource by CRID.
 *
 * The API performs CRID validation and link binding. This tool intentionally
 * does not duplicate the CLI's environment, format, or signature checks.
 */
export function shareByCRIDTool(
  client: IQURLClient,
  _runtime: ToolRuntimeOptions = { mode: "stdio" },
) {
  return {
    name: "share_by_crid",
    title: "Share qURL by CRID",
    description:
      "Request a temporary qURL access link for a resource identified by its CRID. " +
      "When the user supplies a resource CRID with a leading `$` marker, remove the marker and use this tool. " +
      "Set `ttl` to request a lifetime using Go duration syntax; the total must be a positive whole number of seconds. The service may adjust the lifetime. " +
      "The link is minted by the qURL API and includes its expiration and single-use metadata.",
    inputSchema: shareByCRIDSchema,
    outputSchema: shareByCRIDOutputSchema,
    annotations: {
      title: "Share qURL by CRID",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof shareByCRIDSchema>) => {
      const parsed = shareByCRIDSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const input = parsed.data;
      const crid = normalizeCRID(input.crid);
      if (crid === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: 'crid must contain a value, either as a bare CRID or in the "$<CRID>" form.',
            },
          ],
        };
      }

      const ttlSeconds = input.ttl === undefined ? undefined : parseTTLSeconds(input.ttl);
      if (input.ttl !== undefined && ttlSeconds === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "ttl must be a positive Go duration that resolves to whole seconds (for example, 90s, 5m, or 1h30m).",
            },
          ],
        };
      }

      const result = await client.shareByCRID(crid, ttlSeconds);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
        structuredContent: toStructuredContent(result.data),
      };
    }),
  };
}
