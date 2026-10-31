import { z } from "zod";
import type { IQURLClient } from "../client.js";
import {
  allowsServerApiKeyFallback,
  resourceOnlyIdSchema,
  toStructuredContent,
  withMissingApiKeyHandler,
  zodErrorToToolResult,
  type ToolRuntimeOptions,
} from "./_shared.js";
import { mintedUploadedFileLinkOutputSchema } from "./output-schemas.js";
import { getConnectorConfig, mintUploadedFileLink } from "./upload-file-shared.js";
import { uploadMintOptionsSchema, UPLOADED_FILE_LINK_DESCRIPTION } from "./upload-mint-options.js";

export const mintUploadedFileLinkSchema = z.object({
  resource_id: resourceOnlyIdSchema("mint a link for the stored upload"),
  ...uploadMintOptionsSchema.omit({ label: true }).shape,
});

export function mintUploadedFileLinkTool(_client: IQURLClient, runtime: ToolRuntimeOptions) {
  return {
    name: "mint_uploaded_file_link",
    title: "Mint Uploaded File Link",
    description:
      "Mint a fresh link for an existing uploaded file using the resource_id returned by an upload tool or its failed-mint error. " +
      "Use this instead of `upload_file_data_qurl`, `upload_file_qurl`, or `upload_text_qurl` when the file is already stored; no file bytes are uploaded again. " +
      "Use `mint_link` for ordinary API resources, not uploaded files. This calls the file connector's mint route with the caller's credential. " +
      "Each call makes one mint attempt and can create a new live link. A previous failed or timed-out attempt may also have minted a link: reconcile that outcome before retrying automatically. Existing links are not cancelled. " +
      UPLOADED_FILE_LINK_DESCRIPTION +
      "Returns the resource_id, new qurl_link, optional qurl_id, confirmed/requested expiry and any expiry or extra-link warnings. Capture the one-shot qurl_link immediately.",
    inputSchema: mintUploadedFileLinkSchema,
    outputSchema: mintedUploadedFileLinkOutputSchema,
    annotations: {
      title: "Mint Uploaded File Link",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (raw: z.infer<typeof mintUploadedFileLinkSchema>) => {
      const parsed = mintUploadedFileLinkSchema.safeParse(raw);
      if (!parsed.success) return zodErrorToToolResult(parsed.error);
      const { resource_id, ...options } = parsed.data;
      const config = getConnectorConfig(allowsServerApiKeyFallback(runtime));
      const result = await mintUploadedFileLink(config, resource_id, options);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: toStructuredContent(result),
      };
    }),
  };
}
