import { z } from "zod";
import type { IQURLClient } from "../client.js";
import {
  toStructuredContent,
  withMissingApiKeyHandler,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { shareByCRIDOutputSchema } from "./output-schemas.js";

export const shareByCRIDSchema = z.object({
  crid: z
    .string()
    .min(1)
    .describe(
      'CRID of the resource to turn into a temporary qURL link. Accepts either the bare CRID or the user-facing "$<CRID>" form.',
    ),
  ttl: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Requested link lifetime in Go duration format, such as "90s", "5m", or "1h30m". The service may grant less.',
    ),
});

const DURATION_PART = /(\d+(?:\.\d+)?|\.\d+)(ms|us|µs|ns|h|m|s)/gy;
const UNIT_SECONDS: Record<string, number> = {
  h: 60 * 60,
  m: 60,
  s: 1,
  ms: 1e-3,
  us: 1e-6,
  µs: 1e-6,
  ns: 1e-9,
};

function parseTTLSeconds(ttl: string): number | undefined {
  let offset = 0;
  let seconds = 0;

  while (offset < ttl.length) {
    DURATION_PART.lastIndex = offset;
    const part = DURATION_PART.exec(ttl);
    if (!part || part.index !== offset) return undefined;

    seconds += Number(part[1]) * UNIT_SECONDS[part[2]];
    offset = DURATION_PART.lastIndex;
  }

  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
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
      "When the user supplies a standalone value beginning with `$` (for example, `$crid_abc123`), interpret the text after `$` as a CRID and use this tool. " +
      "Set `ttl` to request a lifetime using the same duration syntax as `qurl share --ttl`; the service may grant less. " +
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
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof shareByCRIDSchema>) => {
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
