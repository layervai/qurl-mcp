import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export const OAUTH_ISSUER = "https://auth.layerv.ai/";
export const OAUTH_RESOURCE = "https://mcp.connector.layerv.ai/mcp";
export const OAUTH_API_AUDIENCE = "https://api.layerv.ai";
export const OAUTH_CLIENT_ID = "qH003Rwgjj1wvRXs2iFHthczmJs0fGjr";
export const OAUTH_SCOPES = ["qurl:read", "qurl:write", "qurl:resolve"];
const TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const CACHE_LIMIT = 1_000;
const MAX_TOKEN_BYTES = 16_384;
const MAX_EXCHANGE_RESPONSE_BYTES = 32_768;

type Delegation = { token: string; scopes: string[]; expiresAt: number };

function scopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(" ").filter((scope) => OAUTH_SCOPES.includes(scope)))];
}

// This is the existing production Auth0 integration, not a general OAuth proxy.
export function createHostedOAuth(
  secret: string,
  dependencies: { key?: JWTVerifyGetKey; fetch?: typeof fetch } = {},
) {
  if (!secret.trim()) throw new Error("MCP_OAUTH_CLIENT_SECRET is required for hosted OAuth.");
  const key =
    dependencies.key ?? createRemoteJWKSet(new URL(".well-known/jwks.json", OAUTH_ISSUER));
  const resolveKey: JWTVerifyGetKey = async (...args) => {
    if (typeof args[0].kid !== "string" || !args[0].kid) {
      throw new InvalidTokenError("Missing signing key identifier.");
    }
    try {
      return await key(...args);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey) throw error;
      throw new ServerError("Delegated authentication is temporarily unavailable.");
    }
  };
  const exchangeFetch = dependencies.fetch ?? fetch;
  const cache = new Map<string, Delegation>();
  const pending = new Map<string, Promise<Delegation>>();

  async function verify(token: string, audience: string) {
    if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error("Invalid token size");
    const { payload } = await jwtVerify(token, resolveKey, {
      issuer: OAUTH_ISSUER,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    });
    // Sender-constrained tokens need proof validation; never downgrade them to bearer.
    if (payload.cnf !== undefined || typeof payload.sub !== "string" || !payload.sub.trim()) {
      throw new Error("Unsupported token binding or subject");
    }
    return payload;
  }

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const claims = await verify(token, OAUTH_RESOURCE);
        const granted = scopes(claims.scope);
        if (
          granted.length === 0 ||
          typeof claims.azp !== "string" ||
          !claims.azp.trim() ||
          claims["https://layerv.ai/email_verified"] !== true
        ) {
          throw new Error("Missing client or scopes");
        }
        return {
          token,
          clientId: claims.azp,
          scopes: granted,
          expiresAt: claims.exp!,
          resource: new URL(OAUTH_RESOURCE),
          extra: { subject: claims.sub },
        };
      } catch (error) {
        if (error instanceof ServerError) throw error;
        throw new InvalidTokenError("Invalid or expired access token.");
      }
    },

    async delegate(auth: AuthInfo): Promise<Delegation> {
      const digest = createHash("sha256").update(auth.token).digest("hex");
      const now = Date.now() / 1000;
      const cached = cache.get(digest);
      if (cached && cached.expiresAt > now + 5) return cached;
      cache.delete(digest);
      const inFlight = pending.get(digest);
      if (inFlight) return inFlight;
      if (pending.size >= CACHE_LIMIT) throw new ServerError("Token exchange is busy.");
      const exchange = (async () => {
        try {
          const response = await exchangeFetch(new URL("oauth/token", OAUTH_ISSUER), {
            method: "POST",
            redirect: "error",
            signal: globalThis.AbortSignal.timeout(5_000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: OAUTH_CLIENT_ID,
              client_secret: secret,
              subject_token: auth.token,
              subject_token_type: TOKEN_TYPE,
              requested_token_type: TOKEN_TYPE,
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              audience: OAUTH_API_AUDIENCE,
              scope: auth.scopes.join(" "),
            }),
          }).catch(() => {
            throw new ServerError("Delegated authentication is temporarily unavailable.");
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 429 || response.status >= 500) {
              throw new ServerError("Delegated authentication is temporarily unavailable.");
            }
            throw new Error("Token exchange denied");
          }
          // Bound streamed bytes before JSON parsing, including chunked responses.
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Empty token response");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_EXCHANGE_RESPONSE_BYTES) throw new Error("Oversized token response");
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            typeof result !== "object" ||
            result === null ||
            typeof result.access_token !== "string" ||
            result.token_type !== "Bearer" ||
            result.issued_token_type !== TOKEN_TYPE
          ) {
            throw new Error("Unsupported token response");
          }
          const claims = await verify(result.access_token, OAUTH_API_AUDIENCE);
          // API1978 must ignore broad RBAC/custom permissions on tokens with act.
          const actor = claims.act;
          if (
            claims.sub !== auth.extra?.subject ||
            claims.azp !== OAUTH_CLIENT_ID ||
            typeof actor !== "object" ||
            actor === null ||
            !("sub" in actor) ||
            actor.sub !== OAUTH_CLIENT_ID
          )
            throw new Error("Invalid delegated identity");
          const granted = scopes(claims.scope);
          const issued =
            typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
          if (granted.length === 0 || issued.some((scope) => !auth.scopes.includes(scope))) {
            throw new Error("Invalid delegated scopes");
          }
          const delegation = {
            token: result.access_token as string,
            scopes: granted,
            expiresAt: Math.min(auth.expiresAt!, claims.exp!),
          };
          if (delegation.expiresAt <= Date.now() / 1000 + 5)
            throw new Error("Token expires too soon");
          for (const [id, entry] of cache) {
            if (entry.expiresAt <= Date.now() / 1000 + 5) cache.delete(id);
          }
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
          cache.set(digest, delegation);
          return delegation;
        } catch (error) {
          if (error instanceof ServerError) throw error;
          if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
            throw new ServerError("Delegated authentication is temporarily unavailable.");
          }
          // Provider errors and tokens never enter logs or client-visible errors.
          throw new InvalidTokenError("Delegated access is unavailable. Reconnect your account.");
        }
      })();
      pending.set(digest, exchange);
      try {
        return await exchange;
      } finally {
        pending.delete(digest);
      }
    },
  };
}

const TOOL_SCOPES: Record<string, string[]> = {
  submit_feedback: [],
  publish_crid: ["qurl:write"],
  manage_crid_access: ["qurl:write"],
  list_crid_access: ["qurl:read"],
  create_qurl: ["qurl:write"],
  resolve_qurl: ["qurl:resolve"],
  list_qurls: ["qurl:read"],
  get_qurl: ["qurl:read"],
  delete_qurl: ["qurl:write"],
  extend_qurl: ["qurl:write", "qurl:read"],
  update_qurl: ["qurl:write"],
  mint_link: ["qurl:write"],
  mint_uploaded_file_link: ["qurl:write"],
  share_by_crid: ["qurl:resolve"],
  batch_create_qurls: ["qurl:write"],
  revoke_qurl_token: ["qurl:write"],
  update_qurl_token: ["qurl:write"],
  list_qurl_sessions: ["qurl:read"],
  terminate_qurl_sessions: ["qurl:write"],
  upload_file_qurl: ["qurl:write"],
  upload_file_data_qurl: ["qurl:write"],
  upload_text_qurl: ["qurl:write"],
};

export function toolScopes(name: string): string[] {
  if (!Object.hasOwn(TOOL_SCOPES, name)) throw new Error(`Missing OAuth scope policy for ${name}`);
  return TOOL_SCOPES[name];
}
