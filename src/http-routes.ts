export const MCP_HTTP_PATH = "/mcp";
export const HEALTH_HTTP_PATH = "/healthz";
export const LEGAL_HTTP_PATH_PREFIX = "/legal";

// Public-video paths must not shadow protocol, health, or legal routes. Keep
// this list derived from the route constants so adding or renaming one cannot
// silently diverge from config validation.
export const RESERVED_PUBLIC_PATH_PREFIXES = [
  MCP_HTTP_PATH,
  HEALTH_HTTP_PATH,
  LEGAL_HTTP_PATH_PREFIX,
] as const;
