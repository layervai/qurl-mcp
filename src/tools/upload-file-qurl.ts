import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { IQURLClient } from "../client.js";
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
import { uploadMintOptionsShape } from "./upload-mint-options.js";
import {
  getConnectorConfig,
  getMaxUploadFileBytes,
  inferContentType,
  mintUploadedFile,
  normalizeFileName,
  supportedMimeTypes,
  uploadToConnector,
  validateFileNameContentType,
  validateFileSignature,
  type ConnectorConfig,
} from "./upload-file-shared.js";
import { uploadFileQurlOutputSchema } from "./output-schemas.js";

export const uploadFileQurlSchema = z
  .object({
    file_path: z
      .string()
      .min(1)
      .max(4096)
      .describe("Path to a local PDF or raster image file on the MCP server host"),
    file_name: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Optional override for the uploaded filename; defaults to the source basename"),
    content_type: z
      .enum(supportedMimeTypes)
      .optional()
      .describe(
        "Optional MIME type confirmation. It must match the filename extension. Supported: application/pdf, image/png, image/jpeg, image/webp, image/gif",
      ),
    email_delivery: emailDeliveryInputSchema
      .optional()
      .describe(
        "Optional email notification settings for sending the uploaded file's qURL to one or more recipients.",
      ),
  })
  .extend(uploadMintOptionsShape);

export type UploadFileQurlInput = z.infer<typeof uploadFileQurlSchema>;

export async function readFileWithinLimit(
  fileHandle: FileHandle,
  maxBytes: number,
  initialSize: number,
): Promise<Uint8Array> {
  // Read at most one byte beyond the limit. Unlike FileHandle.readFile(), this
  // remains bounded if the file grows after the initial stat. Start near the
  // observed size so a small file does not reserve the full configured limit.
  // allocUnsafe is safe because only the initialized prefix is returned below;
  // never return `buffer` without slicing it to totalBytesRead.
  let buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(1, initialSize + 1)));
  let totalBytesRead = 0;

  while (true) {
    if (totalBytesRead === buffer.byteLength) {
      if (totalBytesRead > maxBytes) break;
      const nextCapacity = Math.min(
        maxBytes + 1,
        Math.max(buffer.byteLength * 2, buffer.byteLength + 64 * 1024),
      );
      const expanded = Buffer.allocUnsafe(nextCapacity);
      buffer.copy(expanded, 0, 0, totalBytesRead);
      buffer = expanded;
    }
    const { bytesRead } = await fileHandle.read(
      buffer,
      totalBytesRead,
      buffer.byteLength - totalBytesRead,
      null,
    );
    if (bytesRead === 0) break;
    totalBytesRead += bytesRead;
  }

  if (totalBytesRead > maxBytes) {
    throw new Error("File exceeds the configured upload size limit.");
  }
  return buffer.subarray(0, totalBytesRead);
}

async function uploadLocalFileAndMint(
  client: IQURLClient,
  input: UploadFileQurlInput,
  connectorConfig: ConnectorConfig,
) {
  // Preflight config before reading local files so misconfigured hosts fail fast.
  const sourcePath = resolve(input.file_path);
  // O_NOFOLLOW protects the final component. Intermediate directory symlinks
  // still follow normal filesystem semantics; this tool is stdio-only and the
  // local user explicitly chooses the server-host path to share. Callers must
  // never expose this helper to HTTP input or pass an HTTP caller-controlled path.
  const fileName = normalizeFileName(input.file_name ?? sourcePath);
  const contentType = input.content_type ?? inferContentType(fileName);
  if (!contentType) {
    throw new Error(
      "Unsupported file type. Provide a PDF, PNG, JPEG, WEBP, or GIF file, or set content_type explicitly.",
    );
  }

  validateFileNameContentType(fileName, contentType);

  const maxBytes = getMaxUploadFileBytes();
  let fileHandle: FileHandle;
  try {
    fileHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOOP") {
      throw new Error("file_path must not point to a symbolic link");
    }
    throw error;
  }
  let fileData: Uint8Array;
  try {
    const sourceStat = await fileHandle.stat();
    if (!sourceStat.isFile()) throw new Error("file_path must point to a regular file");
    if (sourceStat.size === 0) throw new Error("File is empty.");
    if (sourceStat.size > maxBytes) {
      throw new Error("File exceeds the configured upload size limit.");
    }
    fileData = await readFileWithinLimit(fileHandle, maxBytes, sourceStat.size);
  } finally {
    await fileHandle.close();
  }
  validateFileSignature(fileData, contentType);
  const upload = await uploadToConnector(fileData, fileName, contentType, connectorConfig);
  return mintUploadedFile(
    client,
    upload.resource_id,
    { name: fileName, contentType, sizeBytes: fileData.byteLength },
    input,
  );
}

export async function uploadGeneratedFileAndMint(
  client: IQURLClient,
  input: UploadFileQurlInput,
  connectorConfig: ConnectorConfig,
) {
  const sourcePath = resolve(input.file_path);
  const relativeToTemp = relative(resolve(tmpdir()), sourcePath);
  if (
    isAbsolute(relativeToTemp) ||
    relativeToTemp === ".." ||
    relativeToTemp.startsWith(`..${sep}`)
  ) {
    throw new Error("Generated upload files must remain inside the server temporary directory.");
  }
  return uploadLocalFileAndMint(client, { ...input, file_path: sourcePath }, connectorConfig);
}

export function uploadFileQurlTool(client: IQURLClient, runtime: ToolRuntimeOptions) {
  return {
    name: "upload_file_qurl",
    title: "Upload File qURL",
    description:
      "Upload a local PDF or raster image file to a qURL connector, then mint an access link for it. " +
      "Use this when the content already exists on the MCP server host and you need a shareable file qURL rather than a proxy to an existing website URL. " +
      "This stdio-only tool can read any supported file that the local MCP process user can access; invoke it only for a path the user explicitly chose to share. " +
      "Deploy stdio under a restricted OS account or container whose readable files are limited to intended shareable content. " +
      "Use `create_qurl` when you already have a URL, and use `mint_link` when the file has already been uploaded and you only need another token. " +
      "The tool reads `file_path`, uploads the file to `${QURL_CONNECTOR_URL}/api/upload`, then mints a qURL from the returned `resource_id`. " +
      "If `one_time_use` is omitted, the tool defaults it to `true` for safer file distribution. " +
      "Requires both `QURL_API_KEY` and `QURL_CONNECTOR_URL` in the server environment or runtime config. " +
      "**Returns:** `{ resource_id: string, qurl_id: string, qurl_link: string, qurl_site?: string, expires_at?: string, file_name: string, content_type: string, size_bytes: number, branded_domain?: string, type?: string, email_delivery?: object }`.",
    inputSchema: uploadFileQurlSchema,
    outputSchema: uploadFileQurlOutputSchema,
    annotations: {
      title: "Upload File qURL",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: withMissingApiKeyHandler(async (input: UploadFileQurlInput) => {
      // getToolFactoriesForMode also omits this factory from HTTP registration;
      // retain the handler guard for direct embedding and future registry changes.
      if (runtime.mode !== "stdio") {
        throw new Error("upload_file_qurl is available only in stdio mode");
      }
      const allowServerApiKeyFallback = allowsServerApiKeyFallback(runtime);
      const connectorConfig = getConnectorConfig(allowServerApiKeyFallback);
      const result = await uploadLocalFileAndMint(client, input, connectorConfig);
      const emailResult = await maybeDeliverToolEmail({
        allowServerApiKeyFallback,
        delivery: input.email_delivery,
        defaultSubject: "Your secure file access link is ready",
        detailLines: uploadEmailDetailLines({
          intro: "A secure qURL file link has been created for you.",
          fileName: result.file_name,
          contentType: result.content_type,
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
