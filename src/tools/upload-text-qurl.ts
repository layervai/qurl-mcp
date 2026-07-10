import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { formatErrorForLog } from "../logging.js";
import { createTextPdfTempFile, MAX_TEXT_PDF_CONTENT_CHARACTERS } from "../services/text-pdf.js";
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
      .describe(
        "Text content to render into a temporary PDF before uploading to the qURL connector.",
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

export function uploadTextQurlTool(client: IQURLClient, runtime: ToolRuntimeOptions) {
  return {
    name: "upload_text_qurl",
    title: "Upload Text qURL",
    description:
      "Render text content into a temporary PDF, upload that PDF to a qURL connector, then mint an access link for it. " +
      "Use this when the user gives you text content and wants a qURL without first creating a local file or hosting a URL somewhere else. " +
      "Use `upload_file_data_qurl` for binary/image/PDF attachments, use `upload_file_qurl` when a file already exists on disk, and use `create_qurl` when you already have a target URL. " +
      "In v1 the tool does not apply markdown rich-text rendering; it writes the provided content into a plain-text PDF, uploads it to `${QURL_CONNECTOR_URL}/api/upload`, then mints a qURL from the returned `resource_id`. " +
      "If `one_time_use` is omitted, the tool defaults it to `true` to match the uploaded-content sharing flow. " +
      "Requires `QURL_CONNECTOR_URL`; stdio reads `QURL_API_KEY` from server config, while HTTP uses the caller's bearer credential. " +
      "**Returns:** `{ resource_id: string, qurl_id: string, qurl_link: string, qurl_site?: string, expires_at?: string, file_name: string, content_type: string, size_bytes: number, branded_domain?: string, type?: string, email_delivery?: object }`.",
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
          client,
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
            qurlSite: result.qurl_site,
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
