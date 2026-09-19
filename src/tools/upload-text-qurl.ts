import { z } from "zod";
import { Buffer } from "node:buffer";
import type { IQURLClient } from "../client.js";
import { formatErrorForLog } from "../logging.js";
import {
  createTextPdfTempFile,
  MAX_TEXT_PDF_CONTENT_BYTES,
  MAX_TEXT_PDF_CONTENT_CHARACTERS,
} from "../services/text-pdf.js";
import {
  allowsServerApiKeyFallback,
  withMissingApiKeyHandler,
  type ToolRuntimeOptions,
} from "./_shared.js";
import {
  emailDeliveryInputSchema,
  maybeDeliverToolEmail,
  toEmailAugmentedResult,
  uploadEmailDetailLines,
} from "./email-delivery.js";
import { uploadFileQurlOutputSchema } from "./output-schemas.js";
import { getConnectorConfig } from "./upload-file-shared.js";
import { uploadGeneratedFileAndMint } from "./upload-file-qurl.js";
import { uploadMintOptionsShape } from "./upload-mint-options.js";

const supportedTextPayloadTypes = ["text", "markdown", "html", "json"] as const;

export const uploadTextQurlSchema = z
  .object({
    type: z
      .enum(supportedTextPayloadTypes)
      .describe(
        "Source text type, such as `markdown`. In v1 this is preserved as metadata and the content is rendered into a plain-text PDF before upload.",
      ),
    content: z
      .string()
      .min(1)
      .max(MAX_TEXT_PDF_CONTENT_CHARACTERS)
      .refine((content) => Buffer.byteLength(content, "utf8") <= MAX_TEXT_PDF_CONTENT_BYTES, {
        message: `Text content must not exceed ${MAX_TEXT_PDF_CONTENT_BYTES / 1024} KiB when UTF-8 encoded`,
      })
      .describe(
        "Text content to render into a temporary PDF before uploading to the qURL connector (max 100,000 UTF-16 units and 256 KiB UTF-8).",
      ),
    file_name: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Filename to register with the connector. The tool will normalize it to a `.pdf` filename.",
      ),
    email_delivery: emailDeliveryInputSchema
      .optional()
      .describe(
        "Optional email notification settings for sending the uploaded text content's qURL to one or more recipients.",
      ),
  })
  .extend(uploadMintOptionsShape);

export function uploadTextQurlTool(
  // Unused since links are minted by the connector; kept for the shared tool factory signature.
  _client: IQURLClient,
  runtime: ToolRuntimeOptions,
) {
  return {
    name: "upload_text_qurl",
    title: "Upload Text qURL",
    description:
      "Render text content into a temporary PDF, upload that PDF to a qURL connector, then mint an access link for it. " +
      "Use this when the user gives you text content and wants a qURL without first creating a local file or hosting a URL somewhere else. " +
      "Use `upload_file_data_qurl` for binary/image/PDF attachments, use `upload_file_qurl` when a file already exists on disk, and use `create_qurl` when you already have a target URL. " +
      "In v1 the tool does not apply markdown rich-text rendering; it writes the provided content into a plain-text PDF, uploads it to `${QURL_CONNECTOR_URL}/api/upload`, then mints the link through `${QURL_CONNECTOR_URL}/api/mint_link/:resource_id`. Uploaded-file links support `expires_in`, `one_time_use`, and `session_duration`; `access_policy` and `max_sessions` are rejected. **Revocation:** a link created here cannot be revoked from this server; `delete_qurl` on the returned `resource_id` does not stop it (revocation needs the connector's `/api/revoke_links`). Use a short `expires_in` and `one_time_use` for sensitive files. " +
      "If `one_time_use` is omitted, the tool defaults it to `true` to match the uploaded-content sharing flow. " +
      "Requires `QURL_CONNECTOR_URL`; stdio reads `QURL_API_KEY` from server config, while HTTP uses the caller's bearer credential. " +
      "**Returns:** `{ resource_id: string, qurl_id: string, qurl_link: string, expires_at?: string, requested_expires_at?: string, expires_at_differs_from_request?: boolean, expires_at_unconfirmed?: boolean, unexpected_extra_link_count?: number, unexpected_extra_qurl_ids?: string[], file_name: string, content_type: string, size_bytes: number, email_delivery?: object }`. If `unexpected_extra_link_count` is present, the connector minted extra live links: tell the user. If `expires_at_differs_from_request` is set, tell the user the actual `expires_at`; if `expires_at_unconfirmed` is set, say the requested lifetime was not confirmed.",
    inputSchema: uploadTextQurlSchema,
    outputSchema: uploadFileQurlOutputSchema,
    annotations: {
      title: "Upload Text qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof uploadTextQurlSchema>) => {
      const {
        type,
        content,
        file_name: fileName,
        email_delivery: emailDelivery,
        ...mintOptions
      } = input;
      const allowServerApiKeyFallback = allowsServerApiKeyFallback(runtime);
      const requestedFileName = fileName ?? "content.pdf";

      const connectorConfig = getConnectorConfig(allowServerApiKeyFallback);

      const pdfFile = await createTextPdfTempFile({
        content,
        fileName: requestedFileName,
        title: mintOptions.label ?? requestedFileName,
      });

      try {
        const result = await uploadGeneratedFileAndMint(
          {
            file_path: pdfFile.filePath,
            file_name: pdfFile.fileName,
            content_type: "application/pdf",
            ...mintOptions,
          },
          connectorConfig,
        );

        const emailResult = await maybeDeliverToolEmail({
          allowServerApiKeyFallback,
          delivery: emailDelivery,
          defaultSubject: "Your secure text access link is ready",
          detailLines: uploadEmailDetailLines({
            intro: "A secure qURL text link has been created for you.",
            fileName: result.file_name,
            contentType: result.content_type,
            qurlLink: result.qurl_link,
            expiresAt: result.expires_at,
            label: mintOptions.label,
            extraLines: [`Payload Type: ${type}`],
          }),
        });

        return toEmailAugmentedResult(result, emailResult);
      } finally {
        try {
          await pdfFile.cleanup();
        } catch (error) {
          // Cleanup is best-effort and must not turn a successful upload into a tool failure.
          console.error(`Failed to clean up a temporary text PDF (${formatErrorForLog(error)})`);
        }
      }
    }),
  };
}
