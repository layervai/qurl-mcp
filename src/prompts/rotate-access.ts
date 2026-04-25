import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

export const rotateAccessArgs = {
  resource_id: z.string().describe("The resource ID of the qURL to rotate"),
  expires_in: z
    .string()
    .optional()
    .describe('New expiration duration for the replacement qURL (e.g., "24h", "7d")'),
};

type RotateAccessInput = z.infer<z.ZodObject<typeof rotateAccessArgs>>;

export function rotateAccessPrompt() {
  return {
    name: "rotate-access",
    description:
      "Rotate a qURL by revoking the existing link and creating a fresh one with the same target.",
    args: rotateAccessArgs,
    handler: (args: RotateAccessInput): GetPromptResult => {
      const expiry = args.expires_in ?? "24h";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Rotate access for qURL ${args.resource_id}. Follow these steps:`,
                "",
                `1. Use the get_qurl tool to fetch the current details for resource_id "${args.resource_id}".`,
                "2. Note the target_url, tags, and description from the existing qURL — you will restore them on the new resource.",
                `3. Use the delete_qurl tool to revoke the old qURL "${args.resource_id}".`,
                `4. Use the create_qurl tool to create a new qURL with the same target_url, with expires_in set to "${expiry}". (tags and description live on the resource and are not accepted by create_qurl — they will be applied in the next step via update_qurl.)`,
                "5. If the original had tags or a description, use the update_qurl tool on the new resource_id to restore them.",
                "6. Confirm the rotation was successful and provide the new qurl_link from the create_qurl response.",
                "",
                "Tip: If you only need a fresh access link (not a full rotation), use the mint_link tool instead.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  };
}
