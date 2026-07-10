import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { extname, isAbsolute, normalize, resolve } from "node:path";
import { isEmailAddress, normalizeEmailAddress, normalizeEmailDomain } from "./email-addresses.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string;
  allowedRecipients?: string[];
  allowedRecipientDomains?: string[];
  maxRecipientsPerMessage: number;
  maxRecipientsPerHour: number;
}

export interface RuntimeConfig {
  maxUploadFileDataBytes: number;
  defaultQurlApiUrl: string;
  defaultQurlConnectorUrl?: string;
  qurlApiKey?: string;
  smtp?: SmtpConfig;
  publicVideo?: PublicVideoConfig;
}

export interface PublicVideoConfig {
  title: string;
  pagePath: string;
  filePath: string;
}

export interface SmtpConfigInspection {
  enabled: boolean;
  missingFields: string[];
  securityWarnings: string[];
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  fromEmail?: string;
  fromName?: string;
}

// This describes recognized keys for downstream parsing, not validated data.
// Every consumer must still narrow/parse its field after this unchecked JSON
// boundary.
export type UncheckedConfigFileShape = Partial<{
  port: number;
  host: string;
  baseUrl: string;
  allowedHosts: string[];
  trustProxyHops: number;
  maxSessions: number;
  maxSessionsPerCredential: number;
  maxUnvalidatedSessions: number;
  sessionIdleTtlMs: number;
  sessionAbsoluteTtlMs: number;
  unvalidatedSessionTtlMs: number;
  mcpRateLimitPerMinute: number;
  publicFileRateLimitPerMinute: number;
  maxUploadFileDataBytes: string | number;
  defaultQurlApiUrl: string;
  defaultQurlConnectorUrl: string;
  smtp: Partial<SmtpConfig>;
  publicVideo: Partial<PublicVideoConfig>;
}>;

const DEFAULT_CONFIG_PATH = "qurl-mcp.config.json";
export const DEFAULT_QURL_API_URL = "https://api.layerv.ai";
export const DEFAULT_PUBLIC_VIDEO_TITLE = "Video Showcase";
export const DEFAULT_PUBLIC_VIDEO_PAGE_PATH = "/media/video";
export const MAX_PUBLIC_VIDEO_TITLE_CHARACTERS = 200;
export const DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_FILE_DATA_BYTES = 100 * 1024 * 1024;
export const MAX_CONFIG_ALLOWLIST_ENTRIES = 1_000;

/**
 * Module-level cache for runtime config. Keyed by resolved config path and
 * invalidated when the relevant environment or config-file metadata changes.
 * Call `clearRuntimeConfigCache()` to force a reload (useful for testing).
 */
const RUNTIME_CONFIG_ENV_KEYS = [
  "MCP_MAX_UPLOAD_FILE_DATA_BYTES",
  "QURL_API_KEY",
  "QURL_API_URL",
  "QURL_CONNECTOR_URL",
  "QURL_PUBLIC_VIDEO_FILE_PATH",
  "QURL_PUBLIC_VIDEO_PAGE_PATH",
  "QURL_PUBLIC_VIDEO_TITLE",
  "QURL_SMTP_ALLOWED_RECIPIENTS",
  "QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS",
  "QURL_SMTP_FROM_EMAIL",
  "QURL_SMTP_FROM_NAME",
  "QURL_SMTP_HOST",
  "QURL_SMTP_MAX_RECIPIENTS_PER_HOUR",
  "QURL_SMTP_MAX_RECIPIENTS_PER_MESSAGE",
  "QURL_SMTP_PASSWORD",
  "QURL_SMTP_PORT",
  "QURL_SMTP_SECURE",
  "QURL_SMTP_USERNAME",
] as const;

const runtimeConfigCache = new Map<
  string,
  {
    environmentFingerprint: string;
    fileFingerprint: string;
    config: RuntimeConfig;
    smtpInspection: SmtpConfigInspection;
  }
>();

function getRuntimeConfigEnvironmentFingerprint(): string {
  const hash = createHash("sha256");
  for (const key of RUNTIME_CONFIG_ENV_KEYS) {
    hash
      .update(key)
      .update("\0")
      .update(process.env[key] ?? "")
      .update("\0");
  }
  return hash.digest("hex");
}

function getConfigFileFingerprint(configPath: string): string {
  try {
    const stats = statSync(configPath, { bigint: true });
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "missing";
    throw error;
  }
}

const SIZE_UNITS = new Map<string, number>([
  ["b", 1],
  ["kb", 1024],
  ["mb", 1024 * 1024],
  ["gb", 1024 * 1024 * 1024],
]);

export function parseConfigFile(configPath: string): UncheckedConfigFileShape {
  try {
    const content = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Configuration file root must be a JSON object.");
    }
    const record = parsed as Record<string, unknown>;
    for (const field of ["smtp", "publicVideo"] as const) {
      const value = record[field];
      if (
        value !== undefined &&
        (typeof value !== "object" || value === null || Array.isArray(value))
      ) {
        throw new Error(`${field} must be a JSON object.`);
      }
    }
    return parsed as UncheckedConfigFileShape;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    const detail = error instanceof Error ? error.message : "unknown configuration error";
    throw new Error(`Failed to parse configuration file ${configPath}: ${detail}`, {
      cause: error,
    });
  }
}

export function parseSizeBytes(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${fieldName} must be a positive number.`);
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a positive byte size.`);
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  if (/^\d+$/.test(trimmed)) {
    const bytes = Number(trimmed);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`${fieldName} must be a positive number.`);
    }
    return bytes;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/.exec(trimmed);
  if (!match) {
    throw new Error(`${fieldName} must be a positive byte size like 10485760, 10mb, or 512kb.`);
  }

  const amount = Number(match[1]);
  const unit = SIZE_UNITS.get(match[2]);
  if (!Number.isFinite(amount) || amount <= 0 || !unit) {
    throw new Error(`${fieldName} must be a positive byte size.`);
  }

  const bytes = amount * unit;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${fieldName} must resolve to a positive whole number of bytes.`);
  }
  return bytes;
}

export function getDefaultConfigPath(): string {
  const explicitPath = process.env.QURL_MCP_CONFIG;
  if (explicitPath) {
    return resolve(process.cwd(), explicitPath);
  }
  return resolve(process.cwd(), DEFAULT_CONFIG_PATH);
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") {
    throw new Error("SMTP secure must be a boolean.");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error("SMTP secure must be true or false.");
}

function parsePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseSmtpPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = parsePositiveInteger(value, "SMTP port");
  if (port === undefined || port > 65_535) {
    throw new Error("SMTP port must be an integer between 1 and 65535.");
  }
  return port;
}

export function trimString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Configuration string fields must be strings.");
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  let normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost") return true;
  if (isIP(normalized) === 6) {
    // WHATWG URL parsing canonicalizes expanded IPv6 spellings, including
    // IPv4-mapped addresses, without performing DNS resolution.
    normalized = new URL("http://[" + normalized + "]").hostname.replace(/^\[(.*)\]$/, "$1");
  }
  if (normalized === "::1") return true;
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(normalized);
  if (mappedIpv4 && Number.parseInt(mappedIpv4[1], 16) >> 8 === 127) return true;
  return isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127;
}

function hasDotPathSegment(value: string): boolean {
  const rawPath = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(value.trim())?.[1];
  if (!rawPath) return false;
  try {
    return decodeURIComponent(rawPath)
      .split("/")
      .some((segment) => segment === "." || segment === "..");
  } catch {
    return true;
  }
}

export function normalizeServiceBaseUrl(
  value: string,
  fieldName: string,
  requireHttps: boolean,
): string {
  if (hasDotPathSegment(value)) {
    throw new Error(`${fieldName} must not contain dot path segments or malformed escapes.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid absolute URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} must not contain credentials.`);
  }
  if (url.search) {
    throw new Error(`${fieldName} must not contain a query.`);
  }
  if (url.hash) {
    throw new Error(`${fieldName} must not contain a fragment.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${fieldName} must use HTTP or HTTPS.`);
  }
  if (
    requireHttps &&
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error(`${fieldName} must use HTTPS except for loopback development endpoints.`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseCsvList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw new Error("SMTP recipient allowlists must be strings or arrays of strings.");
  }
  const rawItems = Array.isArray(value) ? value : value.split(",");
  if (rawItems.length > MAX_CONFIG_ALLOWLIST_ENTRIES) {
    throw new Error(
      `SMTP recipient allowlists must contain at most ${MAX_CONFIG_ALLOWLIST_ENTRIES} entries.`,
    );
  }
  const items = rawItems.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const unique = Array.from(new Set(items));
  return unique.length > 0 ? unique : undefined;
}

export function normalizePublicPath(
  value: string | undefined,
  fallback: string,
  fieldName = "publicVideo.pagePath",
): string {
  const trimmed = trimString(value);
  const path = !trimmed ? fallback : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const segments = path.split("/");
  if (
    path === "/" ||
    !/^\/[A-Za-z0-9._~/-]+$/.test(path) ||
    path.includes("//") ||
    segments.some((segment) => segment === "." || segment === "..") ||
    ["/mcp", "/healthz", "/legal"].some(
      (reserved) => path === reserved || path.startsWith(`${reserved}/`),
    )
  ) {
    throw new Error(`${fieldName} must be a non-reserved absolute URL path.`);
  }
  return path.replace(/\/+$/, "");
}

export function normalizeAbsoluteFilePath(value: unknown, fieldName: string): string | undefined {
  const filePath = trimString(value);
  if (!filePath) return undefined;
  if (!isAbsolute(filePath)) {
    throw new Error(`${fieldName} must be an absolute filesystem path.`);
  }
  // Collapse lexical dot segments so logs, startup checks, and request-time
  // reads all refer to one unambiguous operator-selected path.
  return normalize(filePath);
}

function normalizeSmtpHost(host: string): string {
  if (host.length > 253 || /[\r\n]/.test(host)) {
    throw new Error("SMTP host must be a single-line hostname or IP address.");
  }
  const unbracketed = host.replace(/^\[(.*)\]$/, "$1");
  if (isIP(unbracketed) !== 0) return unbracketed;
  const normalized = host.toLowerCase();
  const labels = normalized.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    throw new Error("SMTP host must be a single-line hostname or IP address.");
  }
  return normalized;
}

function validateSmtpCredential(value: string, fieldName: "username" | "password"): void {
  const maximumLength = fieldName === "username" ? 320 : 4096;
  if (value.length > maximumLength || /[\r\n]/.test(value)) {
    throw new Error(
      `SMTP ${fieldName} must be a single line of at most ${maximumLength} characters.`,
    );
  }
}

export function normalizePublicVideoTitle(value: string | undefined): string {
  const title = trimString(value) ?? DEFAULT_PUBLIC_VIDEO_TITLE;
  if (title.length > MAX_PUBLIC_VIDEO_TITLE_CHARACTERS) {
    throw new Error(
      `publicVideo.title must be at most ${MAX_PUBLIC_VIDEO_TITLE_CHARACTERS} characters.`,
    );
  }
  return title;
}

export function normalizePublicVideoConfig(
  rawConfig: Partial<PublicVideoConfig> | undefined,
): PublicVideoConfig | undefined {
  const filePath = normalizeAbsoluteFilePath(rawConfig?.filePath, "publicVideo.filePath");
  if (!filePath) {
    return undefined;
  }
  if (extname(filePath).toLowerCase() !== ".mp4") {
    throw new Error("publicVideo.filePath must reference an MP4 file with a .mp4 extension.");
  }

  return {
    title: normalizePublicVideoTitle(trimString(rawConfig?.title)),
    pagePath: normalizePublicPath(rawConfig?.pagePath, DEFAULT_PUBLIC_VIDEO_PAGE_PATH),
    filePath,
  };
}

function resolvePublicVideoConfig(
  fileConfig: Partial<PublicVideoConfig> | undefined,
): PublicVideoConfig | undefined {
  return normalizePublicVideoConfig({
    filePath:
      trimString(process.env.QURL_PUBLIC_VIDEO_FILE_PATH) ?? trimString(fileConfig?.filePath),
    title: trimString(process.env.QURL_PUBLIC_VIDEO_TITLE) ?? trimString(fileConfig?.title),
    pagePath:
      trimString(process.env.QURL_PUBLIC_VIDEO_PAGE_PATH) ?? trimString(fileConfig?.pagePath),
  });
}

function resolveSmtpConfig(fileConfig: Partial<SmtpConfig> | undefined): SmtpConfig | undefined {
  const { host, port, secure, username, password, fromEmail, fromName } =
    resolveSmtpFieldValues(fileConfig);

  if (!host || !port || secure === undefined || !username || !password || !fromEmail) {
    return undefined;
  }
  if (port === 465 && !secure) {
    throw new Error("SMTP port 465 requires smtp.secure to be true.");
  }

  const normalizedHost = normalizeSmtpHost(host);
  validateSmtpCredential(username, "username");
  validateSmtpCredential(password, "password");

  if (/[\r\n]/.test(fromEmail)) {
    throw new Error("SMTP fromEmail must be a single line.");
  }
  if (fromEmail.length > 254 || !isEmailAddress(fromEmail)) {
    throw new Error("SMTP fromEmail must be a valid email address.");
  }
  if (fromName && (fromName.length > 200 || /[\r\n]/.test(fromName))) {
    throw new Error("SMTP fromName must be a single line of at most 200 characters.");
  }
  const allowedRecipientValues = parseCsvList(
    process.env.QURL_SMTP_ALLOWED_RECIPIENTS ?? fileConfig?.allowedRecipients,
  );
  const allowedRecipients = allowedRecipientValues
    ? Array.from(new Set(allowedRecipientValues.map(normalizeEmailAddress)))
    : undefined;
  if (
    allowedRecipients?.some((recipient) => recipient.length > 254 || !isEmailAddress(recipient))
  ) {
    throw new Error("SMTP allowedRecipients must contain valid email addresses.");
  }
  const allowedRecipientDomainValues = parseCsvList(
    process.env.QURL_SMTP_ALLOWED_RECIPIENT_DOMAINS ?? fileConfig?.allowedRecipientDomains,
  );
  const allowedRecipientDomains = allowedRecipientDomainValues
    ? Array.from(new Set(allowedRecipientDomainValues.map(normalizeEmailDomain)))
    : undefined;
  if (
    allowedRecipientDomains?.some(
      (domain) =>
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          domain,
        ),
    )
  ) {
    throw new Error("SMTP allowedRecipientDomains must contain valid domain names.");
  }
  const maxRecipientsPerMessage =
    parsePositiveInteger(
      process.env.QURL_SMTP_MAX_RECIPIENTS_PER_MESSAGE ?? fileConfig?.maxRecipientsPerMessage,
      "SMTP maxRecipientsPerMessage",
    ) ?? 10;
  const maxRecipientsPerHour =
    parsePositiveInteger(
      process.env.QURL_SMTP_MAX_RECIPIENTS_PER_HOUR ?? fileConfig?.maxRecipientsPerHour,
      "SMTP maxRecipientsPerHour",
    ) ?? 100;
  if (maxRecipientsPerMessage > 100 || maxRecipientsPerHour > 100_000) {
    throw new Error("SMTP recipient limits are unreasonably high.");
  }

  return {
    host: normalizedHost,
    port,
    secure,
    username,
    password,
    fromEmail: normalizeEmailAddress(fromEmail),
    fromName,
    allowedRecipients,
    allowedRecipientDomains,
    maxRecipientsPerMessage,
    maxRecipientsPerHour,
  };
}

function resolveSmtpFieldValues(fileConfig: Partial<SmtpConfig> | undefined) {
  return {
    host: trimString(process.env.QURL_SMTP_HOST) ?? trimString(fileConfig?.host),
    port: parseSmtpPort(trimString(process.env.QURL_SMTP_PORT) ?? fileConfig?.port),
    secure: parseBoolean(trimString(process.env.QURL_SMTP_SECURE) ?? fileConfig?.secure),
    username: trimString(process.env.QURL_SMTP_USERNAME) ?? trimString(fileConfig?.username),
    password: trimString(process.env.QURL_SMTP_PASSWORD) ?? trimString(fileConfig?.password),
    fromEmail: trimString(process.env.QURL_SMTP_FROM_EMAIL) ?? trimString(fileConfig?.fromEmail),
    fromName: trimString(process.env.QURL_SMTP_FROM_NAME) ?? trimString(fileConfig?.fromName),
  };
}

/**
 * Load runtime configuration from file and environment variables.
 * Results are cached per config path, environment fingerprint, and file
 * metadata so edits are picked up without a process restart.
 *
 * @param configPath - Path to config file (defaults to getDefaultConfigPath())
 * @returns Resolved runtime configuration
 */
export function loadRuntimeConfig(configPath = getDefaultConfigPath()): RuntimeConfig {
  const resolvedPath = resolve(configPath);
  const environmentFingerprint = getRuntimeConfigEnvironmentFingerprint();
  const fileFingerprint = getConfigFileFingerprint(resolvedPath);
  const cached = runtimeConfigCache.get(resolvedPath);
  if (
    cached?.environmentFingerprint === environmentFingerprint &&
    cached.fileFingerprint === fileFingerprint
  ) {
    return cached.config;
  }

  const fileConfig = parseConfigFile(resolvedPath);
  const maxUploadFileDataBytes = parseSizeBytes(
    process.env.MCP_MAX_UPLOAD_FILE_DATA_BYTES ?? fileConfig.maxUploadFileDataBytes,
    DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
    "maxUploadFileDataBytes",
  );
  if (maxUploadFileDataBytes > MAX_UPLOAD_FILE_DATA_BYTES) {
    throw new Error("maxUploadFileDataBytes must not exceed 100mb.");
  }
  const defaultQurlApiUrl = normalizeServiceBaseUrl(
    trimString(process.env.QURL_API_URL) || fileConfig.defaultQurlApiUrl || DEFAULT_QURL_API_URL,
    "QURL_API_URL/defaultQurlApiUrl",
    true,
  );
  const connectorUrlValue =
    trimString(process.env.QURL_CONNECTOR_URL) || fileConfig.defaultQurlConnectorUrl;
  const defaultQurlConnectorUrl = connectorUrlValue
    ? normalizeServiceBaseUrl(connectorUrlValue, "QURL_CONNECTOR_URL/defaultQurlConnectorUrl", true)
    : undefined;

  const config: RuntimeConfig = {
    maxUploadFileDataBytes,
    defaultQurlApiUrl,
    defaultQurlConnectorUrl,
    qurlApiKey: trimString(process.env.QURL_API_KEY),
    smtp: resolveSmtpConfig(fileConfig.smtp),
    publicVideo: resolvePublicVideoConfig(fileConfig.publicVideo),
  };
  const smtpInspection = inspectSmtpFileConfig(fileConfig.smtp, resolvedPath);

  runtimeConfigCache.set(resolvedPath, {
    environmentFingerprint,
    fileFingerprint,
    config,
    smtpInspection,
  });
  return config;
}

/**
 * Clear the runtime config cache. Useful for tests or for forcing a reload
 * after an operator deliberately preserves a file's metadata while editing.
 */
export function clearRuntimeConfigCache(): void {
  runtimeConfigCache.clear();
}

function inspectSmtpFileConfig(
  fileConfig: Partial<SmtpConfig> | undefined,
  configPath: string,
): SmtpConfigInspection {
  const { host, port, secure, username, password, fromEmail, fromName } =
    resolveSmtpFieldValues(fileConfig);
  const missingFields = [
    !host ? "host" : undefined,
    !port ? "port" : undefined,
    secure === undefined ? "secure" : undefined,
    !username ? "username" : undefined,
    !password ? "password" : undefined,
    !fromEmail ? "fromEmail" : undefined,
  ].filter((field): field is string => typeof field === "string");
  const securityWarnings: string[] = [];
  if (trimString(fileConfig?.password) && process.platform !== "win32") {
    try {
      if ((statSync(configPath).mode & 0o077) !== 0) {
        securityWarnings.push(
          "SMTP password is stored in a group/other-readable config file. Prefer QURL_SMTP_PASSWORD or restrict the file to owner-only permissions (for example, chmod 600).",
        );
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }

  return {
    enabled: missingFields.length === 0,
    missingFields,
    securityWarnings,
    host,
    port,
    secure,
    username,
    fromEmail,
    fromName,
  };
}

export function inspectSmtpConfig(configPath = getDefaultConfigPath()): SmtpConfigInspection {
  const resolvedPath = resolve(configPath);
  loadRuntimeConfig(resolvedPath);
  const inspection = runtimeConfigCache.get(resolvedPath)?.smtpInspection;
  if (!inspection) {
    throw new Error(`SMTP configuration inspection failed for ${resolvedPath}.`);
  }
  return {
    ...inspection,
    missingFields: [...inspection.missingFields],
    securityWarnings: [...inspection.securityWarnings],
  };
}
