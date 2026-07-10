import { Buffer } from "node:buffer";
import { z } from "zod";
import type { IQURLClient } from "../client.js";
import { MAX_UPLOAD_FILE_DATA_BYTES } from "../config.js";
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
import {
  getConnectorConfig,
  getMaxUploadFileBytes,
  mintUploadedFile,
  normalizeFileName,
  supportedMimeTypes,
  uploadToConnector,
  validateFileNameContentType,
  validateFileSignature,
} from "./upload-file-shared.js";
import { uploadFileQurlOutputSchema } from "./output-schemas.js";
import { uploadMintOptionsShape } from "./upload-mint-options.js";

// Uploads pass three deliberate bounds: a runtime-derived raw-string schema
// ceiling, the HTTP JSON-body limit before tool dispatch, and
// getMaxUploadFileBytes on the normalized decoded payload. The exported schema
// uses the protocol-wide 100 MB hard maximum for direct consumers; registered
// tools advertise the operator's configured decoded-byte limit. HTTP only opens
// a parser ceiling above the 10 MB default for a session already validated by a
// successful downstream qURL API call (see createHttpRuntime).
const MAX_DATA_URL_PREFIX_CHARACTERS = 1024;

export function maxBase64CharactersForBytes(maxBytes: number): number {
  return Math.ceil((maxBytes * 4) / 3) + MAX_DATA_URL_PREFIX_CHARACTERS;
}

export const MAX_UPLOAD_FILE_BASE64_CHARACTERS = maxBase64CharactersForBytes(
  MAX_UPLOAD_FILE_DATA_BYTES,
);

export function createUploadFileDataQurlSchema(
  maxBase64Characters = MAX_UPLOAD_FILE_BASE64_CHARACTERS,
) {
  return z
    .object({
      file_base64: z
        .string()
        .min(1)
        .max(maxBase64Characters)
        .describe(
          "Base64-encoded PDF or raster image content. Raw base64 and data URLs are both accepted. For compressible images, compress them first and then convert them to base64 before calling this tool.",
        ),
      file_name: z
        .string()
        .min(1)
        .max(255)
        .describe(
          "Filename to register with the connector. `.jpg` and `.jpeg` files should use `image/jpeg`.",
        ),
      content_type: z
        .enum(supportedMimeTypes)
        .describe(
          "MIME type for the uploaded file. Supported: application/pdf, image/png, image/jpeg, image/webp, image/gif.",
        ),
      email_delivery: emailDeliveryInputSchema
        .optional()
        .describe(
          "Optional email notification settings for sending the uploaded file's qURL to one or more recipients.",
        ),
    })
    .extend(uploadMintOptionsShape);
}

export const uploadFileDataQurlSchema = createUploadFileDataQurlSchema();

/**
 * Normalize and validate base64 input for file upload.
 *
 * Accepts multiple input formats:
 * - Raw base64: "SGVsbG8gV29ybGQ="
 * - Data URL: "data:image/png;base64,iVBORw0KGgo..."
 * - Base64 with whitespace (e.g., line breaks from copy-paste)
 * - URL-safe base64 (uses - and _ instead of + and /)
 *
 * @param input - Raw base64 string or data URL
 * @returns Normalized standard base64 and the data URL media type, when present
 * @throws Error if input is empty or contains invalid base64 characters
 */
function normalizeBase64Input(input: string): {
  base64: string;
  dataUrlContentType?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("file_base64 must not be empty");
  }

  // Step 1: Parse and strip the data URL prefix if present (e.g.,
  // "data:image/png;base64,"). Return its media type so callers do not need
  // to parse the same prefix again. Bound the regex probe independently of
  // the payload ceiling so even a very large hostile string cannot make
  // prefix parsing scale with the file body.
  const dataUrlPrefixProbe = trimmed.slice(0, MAX_DATA_URL_PREFIX_CHARACTERS);
  const dataUrl = /^data:([^;,]*)(?:;[a-z0-9!#$&^_.+-]+=[^;,\s]*)*;base64,/i.exec(
    dataUrlPrefixProbe,
  );
  if (!dataUrl && trimmed.toLowerCase().startsWith("data:")) {
    throw new Error("Only base64-encoded data URLs are supported.");
  }
  const withoutDataUrl = dataUrl ? trimmed.slice(dataUrl[0].length) : trimmed;

  // Step 2: Remove whitespace (base64 from copy-paste often has line breaks)
  const withoutWhitespace = withoutDataUrl.replace(/\s+/g, "");

  if (!withoutWhitespace) {
    throw new Error("file_base64 must not be empty");
  }

  // Step 3: Accept either the standard or URL-safe alphabet, but reject a
  // mixed alphabet because no conforming encoder emits that representation.
  const usesStandardAlphabet = /^[A-Za-z0-9+/]*={0,2}$/.test(withoutWhitespace);
  const usesUrlSafeAlphabet = /^[A-Za-z0-9_-]*={0,2}$/.test(withoutWhitespace);
  if (!usesStandardAlphabet && !usesUrlSafeAlphabet) {
    throw new Error("file_base64 must be valid base64-encoded content");
  }

  // Step 4: Convert URL-safe base64 to standard base64. URL-safe uses '-'
  // instead of '+' and '_' instead of '/'.
  const normalized = usesStandardAlphabet
    ? withoutWhitespace
    : withoutWhitespace.replace(/-/g, "+").replace(/_/g, "/");

  // Step 5: Validate and fix padding
  // Base64 length must be divisible by 4. Valid lengths mod 4 are: 0, 2, 3
  // Length mod 4 = 1 is always invalid (would represent 6 bits, not enough for a byte)
  const paddingNeeded = normalized.length % 4;
  if (paddingNeeded === 1) {
    throw new Error("file_base64 must be valid base64-encoded content");
  }
  const dataUrlContentType = dataUrl?.[1] ? dataUrl[1].toLowerCase() : undefined;

  // Already properly padded
  if (paddingNeeded === 0) {
    return { base64: normalized, dataUrlContentType };
  }

  // Add missing padding (mod 4 = 2 needs "==", mod 4 = 3 needs "=")
  return {
    base64: normalized.padEnd(normalized.length + (4 - paddingNeeded), "="),
    dataUrlContentType,
  };
}

function decodeBase64File(input: string, maxBytes: number, contentType: string): Uint8Array {
  const tooLargeMessage =
    "Decoded file exceeds the allowed upload size. Reduce the file size and try again.";
  const encodedCharacterLimit = Math.ceil((maxBytes * 4) / 3);
  // Allow normal MIME line wrapping plus a bounded data-URL prefix, but reject
  // runtime-oversized strings before trim/replace normalization copies them.
  const rawCharacterLimit =
    encodedCharacterLimit + Math.ceil(encodedCharacterLimit / 4) + MAX_DATA_URL_PREFIX_CHARACTERS;
  if (input.length > rawCharacterLimit) {
    throw new Error(tooLargeMessage);
  }

  const normalized = normalizeBase64Input(input);
  if (normalized.dataUrlContentType && normalized.dataUrlContentType !== contentType) {
    throw new Error("Data URL media type does not match content_type.");
  }
  const paddingBytes = normalized.base64.endsWith("==")
    ? 2
    : normalized.base64.endsWith("=")
      ? 1
      : 0;
  const decodedByteLength = (normalized.base64.length / 4) * 3 - paddingBytes;
  if (decodedByteLength > maxBytes) {
    throw new Error(tooLargeMessage);
  }
  const fileData = Buffer.from(normalized.base64, "base64");

  if (fileData.byteLength === 0) {
    throw new Error("file_base64 decoded to an empty file");
  }
  // Keep an actual-byte check after the pre-allocation estimate so decoder or
  // normalization behavior cannot silently weaken the configured limit.
  if (fileData.byteLength > maxBytes) {
    throw new Error(tooLargeMessage);
  }

  validateFileSignature(fileData, contentType);

  return fileData;
}

export function uploadFileDataQurlTool(client: IQURLClient, runtime: ToolRuntimeOptions) {
  const inputSchema = createUploadFileDataQurlSchema(
    runtime.maxUploadFileDataBytes === undefined
      ? MAX_UPLOAD_FILE_BASE64_CHARACTERS
      : maxBase64CharactersForBytes(runtime.maxUploadFileDataBytes),
  );
  return {
    name: "upload_file_data_qurl",
    title: "Upload File Data qURL",
    description:
      "Upload base64-encoded PDF or raster image content to a qURL connector, then mint an access link for it. " +
      "This is the correct tool for a single in-chat image, PDF, or file attachment in either MCP transport, especially when the user wants 'the qURL of this image/file' or wants the generated link emailed. " +
      "Use this when you have the file data available but cannot provide a server-local file path. " +
      "Use `upload_file_qurl` when the file already exists on the MCP server host, use `create_qurl` when you already have a URL, and use `mint_link` when the file has already been uploaded and you only need another token. " +
      "For compressible images, compress them before converting to base64 so the request is smaller and more reliable. " +
      "When the server upload limit is configured above 10 MB, a fresh HTTP session must complete a smaller qURL API call before its first larger upload. " +
      "The tool decodes `file_base64`, uploads the file to `${QURL_CONNECTOR_URL}/api/upload`, then mints a qURL from the returned `resource_id`. " +
      "Supported MIME types are application/pdf, image/png, image/jpeg, image/webp, and image/gif. " +
      "If `one_time_use` is omitted, the tool defaults it to `true` for safer file distribution. " +
      "Requires `QURL_CONNECTOR_URL`; stdio reads `QURL_API_KEY` from server config, while HTTP uses the caller's bearer credential. " +
      "**Returns:** `{ resource_id: string, qurl_id: string, qurl_link: string, qurl_site?: string, expires_at?: string, file_name: string, content_type: string, size_bytes: number, branded_domain?: string, type?: string, email_delivery?: object }`.",
    inputSchema,
    outputSchema: uploadFileQurlOutputSchema,
    annotations: {
      title: "Upload File Data qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: z.infer<typeof inputSchema>) => {
      const allowServerApiKeyFallback = allowsServerApiKeyFallback(runtime);
      // Preflight connector config before decoding payloads so auth/config errors fail fast.
      const connectorConfig = getConnectorConfig(allowServerApiKeyFallback);

      const fileName = normalizeFileName(input.file_name);
      validateFileNameContentType(fileName, input.content_type);
      const fileData = decodeBase64File(
        input.file_base64,
        getMaxUploadFileBytes(),
        input.content_type,
      );

      const upload = await uploadToConnector(
        fileData,
        fileName,
        input.content_type,
        connectorConfig,
      );

      const result = await mintUploadedFile(
        client,
        upload.resource_id,
        {
          name: fileName,
          contentType: input.content_type,
          sizeBytes: fileData.byteLength,
        },
        input,
      );

      const emailResult = await maybeDeliverToolEmail({
        allowServerApiKeyFallback,
        delivery: input.email_delivery,
        defaultSubject: "Your secure file access link is ready",
        detailLines: uploadEmailDetailLines({
          intro: "A secure qURL file link has been created for you.",
          fileName,
          contentType: input.content_type,
          qurlLink: result.qurl_link,
          expiresAt: result.expires_at,
          qurlSite: result.qurl_site,
          label: input.label,
        }),
      });
      return toEmailAugmentedResult(result, emailResult);
    }),
  };
}
