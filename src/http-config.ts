import {
  DEFAULT_PUBLIC_VIDEO_PAGE_PATH,
  DEFAULT_PUBLIC_VIDEO_TITLE,
  MAX_CONFIG_ALLOWLIST_ENTRIES,
  getDefaultConfigPath,
  isLoopbackHostname,
  loadRuntimeConfig,
  normalizeAbsoluteFilePath,
  normalizePublicPath,
  parseConfigFile,
  trimString,
  type PublicVideoConfig,
} from "./config.js";
import { resolve } from "node:path";

export interface HttpServerConfig {
  port: number;
  host: string;
  baseUrl: string;
  allowedHosts?: string[];
  trustProxyHops: number;
  maxSessions: number;
  maxSessionsPerCredential: number;
  maxUnvalidatedSessions: number;
  sessionIdleTtlMs: number;
  sessionAbsoluteTtlMs: number;
  unvalidatedSessionTtlMs: number;
  mcpRateLimitPerMinute: number;
  publicFileRateLimitPerMinute: number;
  maxUploadFileDataBytes: number;
  defaultQurlApiUrl: string;
  defaultQurlConnectorUrl?: string;
  publicVideo?: PublicVideoConfig;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_SESSIONS_PER_CREDENTIAL = 20;
const DEFAULT_MAX_UNVALIDATED_SESSIONS = 100;
const DEFAULT_SESSION_IDLE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UNVALIDATED_SESSION_TTL_MS = 60 * 1000;

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  fieldName: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new Error(`${fieldName} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${fieldName} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizeAllowedHosts(hosts: unknown): string[] | undefined {
  if (!hosts) return undefined;
  const values = typeof hosts === "string" ? hosts.split(",") : hosts;
  if (!Array.isArray(values) || values.some((host) => typeof host !== "string")) {
    throw new Error("allowedHosts must be an array or comma-separated list of hostnames or IPs.");
  }
  if (values.length > MAX_CONFIG_ALLOWLIST_ENTRIES) {
    throw new Error(`allowedHosts must contain at most ${MAX_CONFIG_ALLOWLIST_ENTRIES} entries.`);
  }
  const stringValues = values.filter((host): host is string => typeof host === "string");
  const normalized = Array.from(
    new Set(stringValues.map((host) => host.trim().toLowerCase()).filter(Boolean)),
  );
  const invalid = normalized.some((host) => {
    if (!/^[a-z0-9.:[\]-]+$/.test(host)) return true;
    try {
      const parsed = new URL(`http://${host}`);
      return (
        parsed.hostname.replace(/^\[(.*)\]$/, "$1") !== host.replace(/^\[(.*)\]$/, "$1") ||
        parsed.port !== ""
      );
    } catch {
      return true;
    }
  });
  if (invalid) {
    throw new Error("allowedHosts must contain hostnames or IPs without ports or URL schemes.");
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("MCP_BASE_URL/baseUrl must be a valid absolute URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP_BASE_URL/baseUrl must be a valid absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MCP_BASE_URL/baseUrl must not include credentials, a query, or a fragment.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error("MCP_BASE_URL/baseUrl must use HTTPS except for loopback development URLs.");
  }
  return url.toString().replace(/\/$/, "");
}

function resolvePublicVideoFromHttpConfig(
  fileConfig: ReturnType<typeof parseConfigFile>,
): PublicVideoConfig | undefined {
  // Environment overrides are resolved through runtimeConfig.publicVideo,
  // which is preferred below. This fallback intentionally reads only the
  // HTTP file for deployments that keep media settings there.
  const filePath = normalizeAbsoluteFilePath(
    fileConfig.publicVideo?.filePath,
    "publicVideo.filePath",
  );
  if (!filePath) return undefined;

  return {
    title: trimString(fileConfig.publicVideo?.title) ?? DEFAULT_PUBLIC_VIDEO_TITLE,
    pagePath: normalizePublicPath(fileConfig.publicVideo?.pagePath, DEFAULT_PUBLIC_VIDEO_PAGE_PATH),
    filePath,
  };
}

const DEFAULT_HTTP_CONFIG_PATH = "qurl-mcp.http.json";

export function getDefaultHttpConfigPath(): string {
  return resolve(process.cwd(), process.env.QURL_MCP_HTTP_CONFIG ?? DEFAULT_HTTP_CONFIG_PATH);
}

export function loadHttpServerConfig(configPath = getDefaultHttpConfigPath()): HttpServerConfig {
  const fileConfig = parseConfigFile(configPath);
  const runtimeConfig = loadRuntimeConfig(getDefaultConfigPath());
  const port = parseBoundedInteger(
    process.env.MCP_PORT ?? fileConfig.port,
    DEFAULT_PORT,
    "MCP_PORT/port",
    1,
    65535,
  );
  const hostValue = process.env.MCP_HOST ?? fileConfig.host ?? DEFAULT_HOST;
  if (typeof hostValue !== "string") {
    throw new Error("MCP_HOST/host must be a hostname or IP address without a port.");
  }
  const host = hostValue.trim().toLowerCase();
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    throw new Error("MCP_HOST/host must be a hostname or IP address without a port.");
  }
  const baseUrl = normalizeBaseUrl(
    process.env.MCP_BASE_URL ?? fileConfig.baseUrl ?? `http://127.0.0.1:${port}`,
  );
  const allowedHosts = normalizeAllowedHosts(
    process.env.MCP_ALLOWED_HOSTS ?? fileConfig.allowedHosts,
  );
  if (!isLoopbackHostname(host) && !allowedHosts) {
    throw new Error("allowedHosts is required when the HTTP listener is not bound to loopback.");
  }
  const publicVideo = runtimeConfig.publicVideo ?? resolvePublicVideoFromHttpConfig(fileConfig);
  const maxSessions = parseBoundedInteger(
    process.env.MCP_MAX_SESSIONS ?? fileConfig.maxSessions,
    DEFAULT_MAX_SESSIONS,
    "MCP_MAX_SESSIONS/maxSessions",
    1,
    10_000,
  );
  const maxSessionsPerCredential = parseBoundedInteger(
    process.env.MCP_MAX_SESSIONS_PER_CREDENTIAL ?? fileConfig.maxSessionsPerCredential,
    Math.min(DEFAULT_MAX_SESSIONS_PER_CREDENTIAL, maxSessions),
    "MCP_MAX_SESSIONS_PER_CREDENTIAL/maxSessionsPerCredential",
    1,
    maxSessions,
  );
  const sessionIdleTtlMs = parseBoundedInteger(
    process.env.MCP_SESSION_IDLE_TTL_MS ?? fileConfig.sessionIdleTtlMs,
    DEFAULT_SESSION_IDLE_TTL_MS,
    "MCP_SESSION_IDLE_TTL_MS/sessionIdleTtlMs",
    10_000,
    24 * 60 * 60 * 1000,
  );
  const sessionAbsoluteTtlMs = parseBoundedInteger(
    process.env.MCP_SESSION_ABSOLUTE_TTL_MS ?? fileConfig.sessionAbsoluteTtlMs,
    DEFAULT_SESSION_ABSOLUTE_TTL_MS,
    "MCP_SESSION_ABSOLUTE_TTL_MS/sessionAbsoluteTtlMs",
    60_000,
    30 * 24 * 60 * 60 * 1000,
  );
  if (sessionAbsoluteTtlMs < sessionIdleTtlMs) {
    throw new Error("sessionAbsoluteTtlMs must be greater than or equal to sessionIdleTtlMs.");
  }

  return {
    port,
    host,
    baseUrl,
    allowedHosts,
    trustProxyHops: parseBoundedInteger(
      process.env.MCP_TRUST_PROXY_HOPS ?? fileConfig.trustProxyHops,
      0,
      "MCP_TRUST_PROXY_HOPS/trustProxyHops",
      0,
      10,
    ),
    maxSessions,
    maxSessionsPerCredential,
    maxUnvalidatedSessions: parseBoundedInteger(
      process.env.MCP_MAX_UNVALIDATED_SESSIONS ?? fileConfig.maxUnvalidatedSessions,
      DEFAULT_MAX_UNVALIDATED_SESSIONS,
      "MCP_MAX_UNVALIDATED_SESSIONS/maxUnvalidatedSessions",
      1,
      1000,
    ),
    sessionIdleTtlMs,
    sessionAbsoluteTtlMs,
    unvalidatedSessionTtlMs: parseBoundedInteger(
      process.env.MCP_UNVALIDATED_SESSION_TTL_MS ?? fileConfig.unvalidatedSessionTtlMs,
      DEFAULT_UNVALIDATED_SESSION_TTL_MS,
      "MCP_UNVALIDATED_SESSION_TTL_MS/unvalidatedSessionTtlMs",
      10_000,
      5 * 60 * 1000,
    ),
    mcpRateLimitPerMinute: parseBoundedInteger(
      process.env.MCP_RATE_LIMIT_PER_MINUTE ?? fileConfig.mcpRateLimitPerMinute,
      120,
      "MCP_RATE_LIMIT_PER_MINUTE/mcpRateLimitPerMinute",
      1,
      10_000,
    ),
    publicFileRateLimitPerMinute: parseBoundedInteger(
      process.env.MCP_PUBLIC_FILE_RATE_LIMIT_PER_MINUTE ?? fileConfig.publicFileRateLimitPerMinute,
      300,
      "MCP_PUBLIC_FILE_RATE_LIMIT_PER_MINUTE/publicFileRateLimitPerMinute",
      1,
      10_000,
    ),
    maxUploadFileDataBytes: runtimeConfig.maxUploadFileDataBytes,
    defaultQurlApiUrl: runtimeConfig.defaultQurlApiUrl,
    defaultQurlConnectorUrl: runtimeConfig.defaultQurlConnectorUrl,
    publicVideo,
  };
}
