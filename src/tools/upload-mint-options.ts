import { z } from "zod";
import { accessPolicySchema } from "./create-qurl.js";

export const uploadMintOptionsShape = {
  label: z
    .string()
    .max(500)
    .optional()
    .describe("Human-readable label identifying who this qURL is for (max 500 chars)"),
  expires_in: z.string().min(1).optional().describe('Duration string (e.g., "1h", "24h", "7d")'),
  one_time_use: z
    .boolean()
    .optional()
    .describe("Whether the link can only be used once. Defaults to true for uploaded content."),
  max_sessions: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "Maximum concurrent sessions for this qURL token (max 1000). Set one_time_use to false explicitly for 0 to mean unlimited visitors.",
    ),
  session_duration: z
    .string()
    .min(1)
    .optional()
    .describe('How long access lasts after clicking (e.g., "1h")'),
  access_policy: accessPolicySchema.optional().describe("Access control policy for this link"),
};
