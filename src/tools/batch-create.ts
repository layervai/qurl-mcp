import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { createQurlSchema } from "./create-qurl.js";
import { withMissingApiKeyHandler } from "./_shared.js";

export const batchCreateSchema = z.object({
  items: z
    .array(createQurlSchema)
    .min(1)
    .max(100)
    .describe("Array of qURL creation requests (1-100 items)"),
});

export function batchCreateTool(client: IQURLClient) {
  return {
    name: "batch_create_qurls",
    description:
      "Create multiple qURLs in a single request. " +
      "Returns per-item results including any errors for partial failures. " +
      "The response sets isError=true when one or more items fail so agents can branch on partial failure without parsing the JSON.",
    inputSchema: batchCreateSchema,
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof batchCreateSchema>) => {
      const result = await client.batchCreate(input);
      // Defense-in-depth: batchCreate passes through HTTP 400, which is
      // contracted to carry a BatchCreateResponse body with per-item errors.
      // If the API ever returns 400 with a different shape (e.g., a
      // top-level malformed-request error), the downstream `failed > 0`
      // access would be meaningless — surface the raw response as an error
      // so agents get a real signal instead of silent mis-interpretation.
      const data = result.data as Partial<typeof result.data> | undefined;
      if (
        !data ||
        typeof data.failed !== "number" ||
        typeof data.succeeded !== "number" ||
        !Array.isArray(data.results)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unexpected batchCreate response shape: ${JSON.stringify(result).slice(0, 500)}`,
            },
          ],
          isError: true,
        };
      }
      const payload = {
        ...data,
        request_id: result.meta?.request_id,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload),
          },
        ],
        isError: data.failed > 0,
      };
    }),
  };
}
