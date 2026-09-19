import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import {
  getRequestMaxUploadFileDataBytes,
  getRequestQurlApiKey,
  getRequestQurlConnectorUrl,
} from "../auth/request-context.js";
import { MISSING_API_KEY_MESSAGE, QURLAPIError } from "../client.js";
import { isLoopbackHostname, loadRuntimeConfig, normalizeServiceBaseUrl } from "../config.js";
import { formatErrorForLog } from "../logging.js";
import { flattenControlCharacters, isControlCodePoint } from "../text.js";
import { RESOURCE_ID_PATTERN, isQurlDisplayId } from "./_shared.js";
import { parseDurationMs } from "./duration.js";
import type { UploadMintOptionsInput } from "./upload-mint-options.js";

export type UploadMintOptions = Pick<
  UploadMintOptionsInput,
  "expires_in" | "one_time_use" | "session_duration"
>;

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

export function getConnectorConfig(allowServerApiKeyFallback = false): ConnectorConfig {
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
  // or read a potentially large upload payload. getConnectorUploadUrl already
  // guarantees the /api/upload suffix the mint route derives from.
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
  const containsAmbiguousUploadRoute =
    /(?:^|\/)(?:api\/)?upload(?:\/|$)/.test(basePath) && !basePath.endsWith("/api/upload");
  if (containsAmbiguousUploadRoute) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "QURL_CONNECTOR_URL must be a connector service base URL or end exactly with /api/upload.",
    );
  }
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
  if (Buffer.byteLength(name, "utf8") > 255 || hasControlCharacter) {
    throw new Error("file_name must be at most 255 UTF-8 bytes and contain no control characters");
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
    throw new Error(
      "file_name must include a basename and supported PDF or raster image extension (for example, image.png); content_type does not replace the required filename extension.",
    );
  }
  if (inferred !== contentType) {
    throw new Error(`content_type ${contentType} does not match the filename extension.`);
  }
}

export function validateFileSignature(fileData: Uint8Array, contentType: string): void {
  const bytes =
    fileData.buffer instanceof ArrayBuffer
      ? Buffer.from(fileData.buffer, fileData.byteOffset, fileData.byteLength)
      : Buffer.from(fileData);
  // latin1 preserves byte values exactly; Node's ascii decoder masks the high
  // bit and would let non-ASCII bytes impersonate an ASCII magic header.
  // These are bounded type-confusion guards rather than full decoders. Start
  // and end framing rejects bytes appended after a terminal marker, but JPEG
  // and GIF internals and PNG chunk integrity are not parsed; downstream
  // connector validation and nosniff delivery remain the authoritative content
  // boundary.
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  const hasPdfTrailer = (): boolean => {
    const pdfEofIndex = bytes.lastIndexOf(PDF_EOF_MARKER);
    return (
      pdfEofIndex >= 0 &&
      bytes
        .subarray(pdfEofIndex + PDF_EOF_MARKER.length)
        .every((byte) => byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32)
    );
  };
  const valid =
    (contentType === "application/pdf" && ascii(0, 5) === "%PDF-" && hasPdfTrailer()) ||
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

function extractConnectorError(
  parsed: unknown,
  defaultCode: string,
): {
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
    code: stringField(nestedError, "code") ?? stringField(body, "code") ?? defaultCode,
    detail:
      stringField(nestedError, "detail") ??
      stringField(nestedError, "message") ??
      stringField(body, "detail") ??
      stringField(body, "message") ??
      // The connector's gin handlers answer {"error": "<text>"}.
      stringField(body, "error"),
    type: stringField(nestedError, "type"),
    instance: stringField(nestedError, "instance"),
  };
}

/**
 * Throw a QURLAPIError from a failed connector response.
 */
function throwConnectorError(
  response: Response,
  parsed: unknown,
  requestId?: string,
  defaultCode = "connector_upload_failed",
): never {
  const { code, detail, type, instance } = extractConnectorError(parsed, defaultCode);
  const safeDetail = detail
    ? flattenControlCharacters(detail).replace(/\s+/g, " ").trim().slice(0, 1024)
    : undefined;
  throw new QURLAPIError(
    response.status,
    code,
    safeDetail || `Connector request failed with HTTP ${response.status}`,
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

// getConnectorUploadUrl guarantees the /api/upload suffix; the mint route is
// its sibling. Fail loudly rather than POST a mint body at the upload route.
function assertConnectorMintable(uploadUrl: string): void {
  if (!new URL(uploadUrl).pathname.endsWith("/api/upload")) {
    throw new QURLAPIError(
      0,
      "invalid_connector_url",
      "Connector upload URL must end with /api/upload.",
    );
  }
}

function connectorMintUrl(uploadUrl: string, resourceId: string): string {
  assertConnectorMintable(uploadUrl);
  const url = new URL(uploadUrl);
  url.pathname = `${url.pathname.slice(0, -"/api/upload".length)}/api/mint_link/${encodeURIComponent(resourceId)}`;
  return url.toString();
}

// The link carries an access token and may be emailed, so never plain HTTP,
// except from a loopback development connector: the same exception the
// connector URL itself gets in normalizeServiceBaseUrl, and only when the
// configured connector is itself loopback.
function isDeliverableLink(value: string, connectorUploadUrl: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname) &&
      isLoopbackHostname(new URL(connectorUploadUrl).hostname)
    );
  } catch {
    return false;
  }
}

type MintedLink = { qurl_id: string; qurl_link: string; expires_at?: unknown };

/** The single link the connector minted, or why its response is unusable. */
function mintedLinkFrom(
  parsed: unknown,
  connectorUploadUrl: string,
): { link: MintedLink; extraCount: number; extraQurlIds: string[] } | { problem: string } {
  const links = (parsed as { links?: unknown } | undefined)?.links;
  const first: unknown = Array.isArray(links) ? links[0] : undefined;
  const link = (typeof first === "object" && first !== null ? first : {}) as Record<
    string,
    unknown
  >;
  if (typeof link.qurl_id !== "string" || typeof link.qurl_link !== "string") {
    return { problem: "Connector mint returned no link." };
  }
  if (!isQurlDisplayId(link.qurl_id))
    return { problem: "Connector mint returned a malformed qurl_id." };
  if (!isDeliverableLink(link.qurl_link, connectorUploadUrl)) {
    // The connector did mint a live link; name it so an operator can act on it.
    return { problem: `Connector mint returned a non-HTTPS link (${link.qurl_id}).` };
  }
  return {
    link: { qurl_id: link.qurl_id, qurl_link: link.qurl_link, expires_at: link.expires_at },
    extraCount: Array.isArray(links) ? links.length - 1 : 0,
    extraQurlIds: (Array.isArray(links) ? links.slice(1) : [])
      .map((extra: unknown) => (extra as { qurl_id?: unknown } | null)?.qurl_id)
      .filter((id): id is string => typeof id === "string" && isQurlDisplayId(id)),
  };
}

/**
 * Mint the recipient link through the connector's `/api/mint_link`, the only
 * link the connector serves for an upload. The upload resource's own target is
 * not a viewable page in the connector's tunnel mode (its per-upload qURL is
 * never shared there), so minting on it with qurl-service yields a link that
 * opens to a 404.
 */
export async function mintUploadedFile(
  connectorConfig: ConnectorConfig,
  resourceId: string,
  file: { name: string; contentType: string; sizeBytes: number },
  input: UploadMintOptions,
) {
  let requestedExpiresAt: string | undefined;
  let requestSent = false;
  let minted: MintedLink;
  let extraCount = 0;
  let extraQurlIds: string[] = [];
  try {
    const expiresInMs = input.expires_in ? parseDurationMs(input.expires_in) : undefined;
    if (input.expires_in && expiresInMs === undefined) {
      // Omitting expires_at would silently give the link the connector default.
      throw new QURLAPIError(0, "invalid_expires_in", `Unsupported duration: ${input.expires_in}`);
    }
    // The connector's mint contract takes an absolute expires_at, so the
    // relative expires_in is anchored to this host's clock.
    requestedExpiresAt =
      expiresInMs !== undefined ? new Date(Date.now() + expiresInMs).toISOString() : undefined;
    const body = {
      n: 1,
      one_time_use: input.one_time_use ?? true,
      ...(requestedExpiresAt ? { expires_at: requestedExpiresAt } : {}),
      ...(input.session_duration ? { session_duration: input.session_duration } : {}),
    };
    const mintUrl = connectorMintUrl(connectorConfig.uploadUrl, resourceId);
    requestSent = true;
    const response = await fetchConnector(mintUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connectorConfig.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const raw = await readConnectorResponseBody(response);
    const contentType = response.headers.get("content-type")?.toLowerCase();
    const unexpected = (message: string) =>
      new QURLAPIError(0, "unexpected_response", message, undefined, undefined, requestId);
    // Same predicate as processConnectorResponse: a missing Content-Type is tolerated.
    if (response.ok && contentType && !contentType.includes("json")) {
      throw unexpected("Connector mint returned a non-JSON response.");
    }
    const parsed = parseJsonBody(raw);
    if (!response.ok) throwConnectorError(response, parsed, requestId, "connector_mint_failed");
    if ((parsed as { success?: unknown } | undefined)?.success === false) {
      const { detail } = extractConnectorError(parsed, "connector_mint_failed");
      const reason = detail
        ? `: ${flattenControlCharacters(detail).replace(/\s+/g, " ").trim().slice(0, 1024)}`
        : "";
      throw unexpected(`Connector mint reported failure${reason}.`);
    }
    const result = mintedLinkFrom(parsed, connectorConfig.uploadUrl);
    if ("problem" in result) throw unexpected(result.problem);
    if (result.extraCount > 0) {
      // n: 1 was requested; extra links are live, so report them, not just log.
      console.error(
        `Connector minted ${result.extraCount + 1} links for ${resourceId}; returning the first`,
      );
    }
    minted = result.link;
    extraCount = result.extraCount;
    extraQurlIds = result.extraQurlIds;
  } catch (error) {
    // The connector API exposes upload but no delete endpoint. Keep the mint
    // error primary and log the orphan resource for operator cleanup.
    console.error(
      `Connector resource ${resourceId} remains after link minting failed ` +
        `(requested expires_at=${requestedExpiresAt ?? "connector default"}; ${formatErrorForLog(error)})`,
    );
    throw new QURLAPIError(
      error instanceof QURLAPIError ? error.statusCode : 0,
      "upload_mint_failed",
      `Upload succeeded but link creation failed. Resource ID: ${resourceId}. ` +
        "The stored file remains on the connector and cannot be deleted or re-linked from this tool; " +
        "retrying uploads another copy." +
        (requestSent
          ? " If the request failed after reaching the connector, a link may already have been minted; check the connector before sharing a replacement."
          : ""),
    );
  }

  // Normalized so the reported (and emailed) expiry is always ISO 8601 or absent.
  const confirmedExpiresAt =
    typeof minted.expires_at === "string" && !Number.isNaN(Date.parse(minted.expires_at))
      ? new Date(minted.expires_at).toISOString()
      : undefined;
  if (
    requestedExpiresAt &&
    confirmedExpiresAt &&
    Math.abs(Date.parse(confirmedExpiresAt) - Date.parse(requestedExpiresAt)) > 60_000
  ) {
    // A clamp or host clock skew changed the link's lifetime; make it visible.
    console.error(
      `Connector link ${minted.qurl_id} expires at ${confirmedExpiresAt}, not the requested ${requestedExpiresAt}`,
    );
  }

  return {
    resource_id: resourceId,
    qurl_id: minted.qurl_id,
    qurl_link: minted.qurl_link,
    // Only a connector-confirmed expiry is reported as expires_at; the request
    // may have been clamped, and expires_at reaches recipients in email.
    expires_at: confirmedExpiresAt,
    ...(requestedExpiresAt && !confirmedExpiresAt
      ? { requested_expires_at: requestedExpiresAt }
      : {}),
    ...(extraCount > 0
      ? { unexpected_extra_link_count: extraCount, unexpected_extra_qurl_ids: extraQurlIds }
      : {}),
    file_name: file.name,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
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
    code === "connector_timeout" ? "Connector request timed out." : "Connector request failed.",
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
  // Security boundary: uploadUrl comes only from operator configuration.
  // Never accept a per-request connector destination here; doing so would
  // turn the caller's forwarded qURL credential into an SSRF disclosure.
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
