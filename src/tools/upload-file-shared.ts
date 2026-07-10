import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import {
  getRequestMaxUploadFileDataBytes,
  getRequestQurlApiKey,
  getRequestQurlConnectorUrl,
} from "../auth/request-context.js";
import {
  MISSING_API_KEY_MESSAGE,
  QURLAPIError,
  type IQURLClient,
  type MintLinkInput,
} from "../client.js";
import { loadRuntimeConfig, normalizeServiceBaseUrl } from "../config.js";
import { formatErrorForLog } from "../logging.js";
import { isControlCodePoint } from "../text.js";
import { RESOURCE_ID_PATTERN } from "./_shared.js";

export const supportedMimeTypes = [
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IEND_CHUNK = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const PDF_EOF_MARKER = Buffer.from("%%EOF", "ascii");

export const mimeTypeByExtension = new Map<string, (typeof supportedMimeTypes)[number]>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

type ConnectorUploadResponse = {
  resource_id: string;
};

export type ConnectorConfig = {
  apiKey: string;
  uploadUrl: string;
};

export function getConnectorConfig(allowServerApiKeyFallback = true): ConnectorConfig {
  let runtimeConfig: ReturnType<typeof loadRuntimeConfig> | undefined;
  const getRuntimeConfig = () => (runtimeConfig ??= loadRuntimeConfig());
  const serverApiKey = allowServerApiKeyFallback
    ? (process.env.QURL_API_KEY?.trim() ?? getRuntimeConfig().qurlApiKey)
    : undefined;
  const apiKey = getRequestQurlApiKey() ?? serverApiKey ?? "";
  if (!apiKey) {
    throw new QURLAPIError(0, "missing_api_key", MISSING_API_KEY_MESSAGE);
  }

  const connectorURL =
    getRequestQurlConnectorUrl() ??
    process.env.QURL_CONNECTOR_URL?.trim() ??
    getRuntimeConfig().defaultQurlConnectorUrl ??
    "";
  if (!connectorURL) {
    throw new QURLAPIError(
      0,
      "missing_connector_url",
      "QURL_CONNECTOR_URL is not set. Set it in the MCP server environment or runtime config to enable file uploads.",
    );
  }

  // Validate operator configuration during preflight, before callers decode
  // or read a potentially large upload payload.
  const uploadUrl = getConnectorUploadUrl(connectorURL);

  return { apiKey, uploadUrl };
}

export function getConnectorUploadUrl(connectorURL: string): string {
  let connectorBaseUrl: URL;
  try {
    connectorBaseUrl = new URL(normalizeServiceBaseUrl(connectorURL, "QURL_CONNECTOR_URL", true));
  } catch (error) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      error instanceof Error ? error.message : "QURL_CONNECTOR_URL must be a valid absolute URL.",
    );
  }

  const basePath = connectorBaseUrl.pathname.replace(/\/$/, "");
  connectorBaseUrl.pathname = basePath.endsWith("/api/upload")
    ? basePath
    : `${basePath}/api/upload`;
  return connectorBaseUrl.toString();
}

export function normalizeFileName(input: string) {
  const name = basename(input.replaceAll("\\", "/")).trim();
  if (!name || name === "." || name === "..") {
    throw new Error("file_name must not be empty");
  }
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isControlCodePoint(codePoint);
  });
  if (name.length > 255 || hasControlCharacter) {
    throw new Error("file_name must be at most 255 characters and contain no control characters");
  }
  return name;
}

export function inferContentType(filePath: string) {
  return mimeTypeByExtension.get(extname(filePath).toLowerCase());
}

export function getMaxUploadFileBytes(): number {
  const requestScoped = getRequestMaxUploadFileDataBytes();
  if (requestScoped !== undefined) return requestScoped;
  return loadRuntimeConfig().maxUploadFileDataBytes;
}

export function validateFileNameContentType(fileName: string, contentType: string): void {
  const inferred = inferContentType(fileName);
  if (!inferred) {
    throw new Error("file_name must use a supported PDF or raster image extension.");
  }
  if (inferred && inferred !== contentType) {
    throw new Error(`content_type ${contentType} does not match the filename extension.`);
  }
}

export function validateFileSignature(fileData: Uint8Array, contentType: string): void {
  const bytes = Buffer.from(fileData.buffer, fileData.byteOffset, fileData.byteLength);
  // latin1 preserves byte values exactly; Node's ascii decoder masks the high
  // bit and would let non-ASCII bytes impersonate an ASCII magic header.
  // These are bounded type-confusion guards rather than full decoders. Start
  // and end framing rejects bytes appended after a terminal marker, but JPEG
  // and GIF internals and PNG chunk integrity are not parsed; downstream
  // connector validation and nosniff delivery remain the authoritative content
  // boundary.
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  const pdfEofIndex = bytes.lastIndexOf(PDF_EOF_MARKER);
  const hasPdfTrailer =
    pdfEofIndex >= 0 &&
    bytes
      .subarray(pdfEofIndex + PDF_EOF_MARKER.length)
      .every((byte) => byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32);
  const valid =
    (contentType === "application/pdf" && ascii(0, 5) === "%PDF-" && hasPdfTrailer) ||
    (contentType === "image/png" &&
      bytes.length >= PNG_SIGNATURE.length + PNG_IEND_CHUNK.length &&
      bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
      bytes.subarray(-PNG_IEND_CHUNK.length).equals(PNG_IEND_CHUNK)) ||
    (contentType === "image/jpeg" &&
      bytes.length >= 6 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9) ||
    (contentType === "image/gif" &&
      ["GIF87a", "GIF89a"].includes(ascii(0, 6)) &&
      bytes[bytes.length - 1] === 0x3b) ||
    (contentType === "image/webp" &&
      bytes.length >= 16 &&
      ascii(0, 4) === "RIFF" &&
      // WebP requires RIFF size + 8 to equal the complete file size. Reject
      // trailing bytes deliberately so a valid prefix cannot bless a polyglot.
      bytes.readUInt32LE(4) + 8 === bytes.length &&
      ascii(8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16)));
  if (!valid) {
    throw new Error(`File content does not match declared content_type ${contentType}.`);
  }
}

/**
 * Parse JSON response body safely, returning undefined on parse failure.
 */
function parseJsonBody(raw: string): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function extractConnectorError(parsed: unknown): {
  code: string;
  detail?: string;
  type?: string;
  instance?: string;
} {
  const body =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const nestedError =
    typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>)
      : {};
  const stringField = (record: Record<string, unknown>, field: string): string | undefined => {
    const value = record[field];
    return typeof value === "string" ? value : undefined;
  };
  return {
    code:
      stringField(nestedError, "code") ?? stringField(body, "code") ?? "connector_upload_failed",
    detail:
      stringField(nestedError, "detail") ??
      stringField(nestedError, "message") ??
      stringField(body, "detail") ??
      stringField(body, "message"),
    type: stringField(nestedError, "type"),
    instance: stringField(nestedError, "instance"),
  };
}

/**
 * Throw a QURLAPIError from a failed connector response.
 */
function throwConnectorError(response: Response, parsed: unknown, requestId?: string): never {
  const { code, detail, type, instance } = extractConnectorError(parsed);
  const safeDetail = detail
    ? Array.from(detail, (character) =>
        isControlCodePoint(character.codePointAt(0) ?? 0) ? " " : character,
      )
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1024)
    : undefined;
  throw new QURLAPIError(
    response.status,
    code,
    safeDetail || `Connector upload failed with HTTP ${response.status}`,
    type,
    instance,
    requestId,
  );
}

/**
 * Extract the raw resource_id field from a connector success response.
 * Handles both `{ resource_id }` and `{ data: { resource_id } }` shapes.
 */
function extractResourceId(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  // Direct shape: { resource_id: string }
  if ("resource_id" in parsed) {
    return parsed.resource_id;
  }

  // Wrapped shape: { data: { resource_id: string } }
  if (
    "data" in parsed &&
    typeof parsed.data === "object" &&
    parsed.data !== null &&
    "resource_id" in parsed.data
  ) {
    return parsed.data.resource_id;
  }

  return undefined;
}

async function readConnectorResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > 64 * 1024) {
      await reader.cancel();
      throw new QURLAPIError(
        0,
        "connector_response_too_large",
        "Connector response exceeded the 64 KiB limit.",
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Process connector response and extract resource_id.
 * Throws QURLAPIError on failure or missing resource_id.
 */
async function processConnectorResponse(response: Response): Promise<ConnectorUploadResponse> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const raw = await readConnectorResponseBody(response);
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (response.ok && contentType && !contentType.includes("json")) {
    throw new QURLAPIError(
      0,
      "unexpected_response",
      "Connector upload succeeded with a non-JSON response.",
      undefined,
      undefined,
      requestId,
    );
  }
  const parsed = parseJsonBody(raw);

  if (!response.ok) {
    throwConnectorError(response, parsed, requestId);
  }

  const resourceId = extractResourceId(parsed);
  if (resourceId === undefined) {
    throw new QURLAPIError(
      0,
      "unexpected_response",
      "Connector upload succeeded but did not return a resource_id.",
      undefined,
      undefined,
      requestId,
    );
  }
  if (typeof resourceId !== "string" || !RESOURCE_ID_PATTERN.test(resourceId)) {
    throw new QURLAPIError(
      0,
      "invalid_resource_id",
      "Connector upload returned a resource_id with an invalid format.",
      undefined,
      undefined,
      requestId,
    );
  }

  return { resource_id: resourceId };
}

export async function mintUploadedFile(
  client: IQURLClient,
  resourceId: string,
  file: { name: string; contentType: string; sizeBytes: number },
  input: MintLinkInput,
) {
  let minted: Awaited<ReturnType<IQURLClient["mintLink"]>>;
  try {
    minted = await client.mintLink(resourceId, {
      label: input.label,
      expires_in: input.expires_in,
      one_time_use: input.one_time_use ?? true,
      max_sessions: input.max_sessions,
      session_duration: input.session_duration,
      access_policy: input.access_policy,
    });
  } catch (error) {
    // The connector API currently exposes upload but no delete endpoint. Keep
    // the mint error primary and log the orphan resource for operator cleanup.
    console.error(
      `Connector resource ${resourceId} remains after link minting failed (${formatErrorForLog(error)})`,
    );
    throw error;
  }

  let qurlSite: string | undefined;
  try {
    qurlSite = (await client.getQURL(resourceId)).data.qurl_site;
  } catch (error) {
    // Non-fatal: qurl_site is optional metadata. Log for debugging but don't fail the upload.
    console.error(
      `Failed to fetch qurl_site for resource ${resourceId} (${formatErrorForLog(error)})`,
    );
  }

  return {
    resource_id: resourceId,
    qurl_id: minted.data.qurl_id,
    qurl_link: minted.data.qurl_link,
    qurl_site: qurlSite,
    expires_at: minted.data.expires_at,
    file_name: file.name,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    branded_domain: minted.data.branded_domain,
    type: minted.data.type,
  };
}

function connectorTransportError(error: unknown): QURLAPIError {
  const code =
    error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
      ? "connector_timeout"
      : "connector_unreachable";
  return new QURLAPIError(
    0,
    code,
    code === "connector_timeout"
      ? "Connector upload timed out."
      : "Connector upload request failed.",
  );
}

async function fetchConnector(
  uploadUrl: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
): Promise<Response> {
  try {
    return await fetch(uploadUrl, {
      ...init,
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw connectorTransportError(error);
  }
}

export async function uploadToConnector(
  fileData: Uint8Array,
  fileName: string,
  contentType: string,
  connectorConfig: ConnectorConfig,
): Promise<ConnectorUploadResponse> {
  const { apiKey, uploadUrl } = connectorConfig;
  const form = new globalThis.FormData();
  // BlobPart's DOM type excludes SharedArrayBuffer-backed views. Reuse the
  // normal ArrayBuffer view without copying; only copy the theoretical shared
  // buffer case into an ordinary Uint8Array.
  const blobData: Uint8Array<ArrayBuffer> =
    fileData.buffer instanceof ArrayBuffer
      ? new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength)
      : new Uint8Array(fileData);
  form.append(
    "file",
    // lgtm[js/file-access-to-http] This tool explicitly uploads caller-provided bytes to the operator-configured connector.
    new globalThis.Blob([blobData], { type: contentType }),
    fileName,
  );
  // The standards-based FormData serializer owns Content-Disposition filename
  // quoting/escaping; never interpolate this value into a raw header.

  // lgtm[js/file-access-to-http] The validated destination and upload are the explicit behavior of this MCP tool.
  const response = await fetchConnector(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    body: form, // lgtm[js/file-access-to-http]
  });

  // fetchConnector's signal remains attached while this reads the response
  // body, so a connector that stalls after sending headers is still bounded.
  try {
    return await processConnectorResponse(response);
  } catch (error) {
    if (error instanceof QURLAPIError) throw error;
    throw connectorTransportError(error);
  }
}
