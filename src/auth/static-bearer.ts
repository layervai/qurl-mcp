import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { QURLClient } from "../client.js";

// This is intentionally shared, non-secret MCP metadata rather than an
// authorization boundary. HTTP sessions are isolated by their bearer-token
// digest and a separate per-session qURL client.
export const PASSTHROUGH_BEARER_CLIENT_ID = "passthrough-bearer-client";
// The MCP SDK requires an expiry for bearer middleware. Actual qURL key
// expiry/revocation is enforced by the downstream API, so use a distant
// UTC epoch-seconds sentinel rather than pretending to know the key's real
// expiry.
const DOWNSTREAM_VALIDATED_TOKEN_EXPIRY = Date.UTC(2100, 0, 1) / 1000;

export interface PassthroughBearerAuthConfig {
  qurlApiUrl: string;
}

export function canonicalizeBearerToken(token: string): string | undefined {
  const canonical = token.trim();
  return canonical || undefined;
}

export function createPassthroughBearerVerifier(): {
  verifyAccessToken(token: string): Promise<AuthInfo>;
} {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const qurlApiKey = canonicalizeBearerToken(token);
      if (!qurlApiKey) {
        console.warn("[mcp-auth] rejected request: empty bearer token");
        throw new InvalidTokenError("Invalid or expired token.");
      }

      // Deliberately accept any non-empty bearer here so MCP metadata and
      // initialization remain available before the downstream qURL API has
      // validated the credential. HTTP session caps, short validation TTLs,
      // and per-request rate limits bound this pre-validation state; tool
      // calls remain authorized by the downstream API using this exact key.
      return {
        token: qurlApiKey,
        clientId: PASSTHROUGH_BEARER_CLIENT_ID,
        scopes: ["mcp:tools"],
        expiresAt: DOWNSTREAM_VALIDATED_TOKEN_EXPIRY,
      };
    },
  };
}

export function createQurlClientFromBearerToken(
  token: string,
  config: PassthroughBearerAuthConfig,
): QURLClient {
  const apiKey = canonicalizeBearerToken(token);
  if (!apiKey) throw new Error("Bearer token must not be empty.");
  return new QURLClient({
    apiKey,
    baseURL: config.qurlApiUrl.trim(),
  });
}
