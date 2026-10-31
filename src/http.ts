#!/usr/bin/env node
import {
  createHttpSessionRegistry,
  type SessionContext,
  type StatelessRequestContext,
} from "./http-sessions.js";
import { createPublicHttpRoutes, createPublicRateLimiter } from "./http-public-routes.js";
import { isHttpEmailAuthorized } from "./services/email.js";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { type createReadStream, existsSync, realpathSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  clearSensitiveLogValues,
  formatErrorForLog,
  installTimestampedConsole,
  logInfo,
  registerSensitiveLogValues,
  sanitizeLogValue,
} from "./logging.js";
import express from "express";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ServerError as OAuthServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { rateLimit } from "express-rate-limit";
import {
  createHostedOAuth,
  OAUTH_RESOURCE,
  OAUTH_API_AUDIENCE,
  OAUTH_ISSUER,
  OAUTH_SCOPES,
} from "./auth/hosted-oauth.js";
import { runWithRequestAuthContext } from "./auth/request-context.js";
import type { IQURLClient } from "./client.js";
import {
  canonicalizeBearerToken,
  createPassthroughBearerVerifier,
  createQurlClientFromBearerToken,
} from "./auth/static-bearer.js";
import {
  DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
  getDefaultConfigPath,
  inspectSmtpConfig,
  loadRuntimeConfig,
  isLoopbackHostname,
} from "./config.js";
import {
  assertDeployedStatelessRequirements,
  assertStatelessParserBudget,
  getDefaultHttpConfigPath,
  getJsonBodyLimitBytes,
  loadHttpServerConfig,
  normalizeMaxConcurrentRequests,
  normalizeRateLimitDynamoDbTable,
  type HttpServerConfig,
} from "./http-config.js";
import { HEALTH_HTTP_PATH, MCP_HTTP_PATH, OAUTH_RESOURCE_METADATA_PATH } from "./http-routes.js";
import { createServer } from "./server.js";
import {
  DynamoDbCredentialRateLimitStore,
  MemoryCredentialRateLimitStore,
  type CredentialRateLimitStore,
} from "./credential-rate-limit-store.js";
import { McpEmfMetrics, normalizeMcpMetricsIdentity } from "./emf-metrics.js";

type AuthorizedSession = {
  session: SessionContext;
  bearerToken: string;
};

const STATELESS_HEADERS_TIMEOUT_MS = 15_000;
const STATELESS_REQUEST_TIMEOUT_MS = 120_000;
const STATELESS_SOCKET_IDLE_TIMEOUT_MS = 120_000;

function requireRateLimitDynamoDbTable(config: HttpServerConfig): string {
  const tableName = normalizeRateLimitDynamoDbTable(config.rateLimitDynamoDbTable);
  if (!tableName) {
    // loadHttpServerConfig enforces this too, but createHttpRuntime is public
    // and can be called directly. Preserve the same fail-fast invariant there.
    throw new Error("rateLimitDynamoDbTable is required for the dynamodb credential store.");
  }
  return tableName;
}

function appendStructuredHeader(res: express.Response, name: string, value: string): void {
  const existing = res.getHeader(name);
  const fields = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  // Structured fields are one comma-joined field value even when independent
  // policies contribute members. Set one physical header line so clients do
  // not have to normalize duplicate RateLimit/RateLimit-Policy lines.
  res.setHeader(name, [...fields.map(String), value].join(", "));
}

export interface HttpRuntimeOptions {
  clientFactory?: (bearerToken: string) => IQURLClient;
  fileStreamFactory?: (
    filePath: string,
    options: { start?: number; end?: number },
  ) => ReturnType<typeof createReadStream>;
  transportFactory?: (stateless?: boolean) => StreamableHTTPServerTransport;
  // Injection is an embedding/test seam, not proof that a backend is shared
  // across replicas. Non-loopback stateless callers must still declare the
  // dynamodb backend in config so the deployed contract stays fail-closed.
  credentialRateLimitStore?: CredentialRateLimitStore;
  runtimeConfigPath?: string;
  version: string;
}

interface McpResponseLocals {
  usingUnvalidatedBodyLimit?: boolean;
  // Verification hands off to exchange; close waits for the active auth phase.
  oauthWork?: Promise<unknown>;
}

export function createHttpRuntime(config: HttpServerConfig, options: HttpRuntimeOptions) {
  const runtimeConfigPath = options.runtimeConfigPath ?? getDefaultConfigPath();
  const version = options.version;
  const port = config.port;
  const host = config.host;
  const baseUrl = config.baseUrl;
  const defaultQurlApiUrl = config.defaultQurlApiUrl;
  const defaultQurlConnectorUrl = config.defaultQurlConnectorUrl;
  const stateless = config.stateless ?? false;
  if (
    config.hostedOAuth &&
    (!stateless ||
      defaultQurlApiUrl !== OAUTH_API_AUDIENCE ||
      `${baseUrl.replace(/\/$/, "")}${MCP_HTTP_PATH}` !== OAUTH_RESOURCE)
  ) {
    throw new Error("Hosted OAuth requires stateless mode and the production MCP/API URLs.");
  }
  const oauth = config.hostedOAuth ? createHostedOAuth(config.oauthClientSecret ?? "") : undefined;
  const resourceMetadataUrl = `${new URL(baseUrl).origin}${OAUTH_RESOURCE_METADATA_PATH}/mcp`;
  const maxConcurrentRequests = normalizeMaxConcurrentRequests(config.maxConcurrentRequests);
  assertStatelessParserBudget(stateless, maxConcurrentRequests, config.maxUploadFileDataBytes);
  let inFlightRequests = 0;

  // This public API can bypass loadHttpServerConfig, so both entry points use
  // one normalizer for the complete, trimmed, stateless-only identity contract.
  const metricsIdentity = normalizeMcpMetricsIdentity(
    {
      namespace: config.metricsNamespace,
      service: config.metricsService,
      environment: config.metricsEnvironment,
    },
    stateless,
  );
  // Embedders can bypass loadHttpServerConfig, so the runtime seam enforces
  // the same load-bearing non-loopback deployment contract.
  assertDeployedStatelessRequirements(
    host,
    stateless,
    config.credentialRateLimitStore ?? "memory",
    metricsIdentity,
  );
  const metrics = new McpEmfMetrics(
    metricsIdentity,
    // Both loader and direct-call validation guarantee a positive denominator.
    () => (inFlightRequests / maxConcurrentRequests) * 100,
  );
  const credentialRateLimitStore =
    options.credentialRateLimitStore ??
    (config.credentialRateLimitStore === "dynamodb"
      ? new DynamoDbCredentialRateLimitStore(requireRateLimitDynamoDbTable(config))
      : new MemoryCredentialRateLimitStore());
  // Injected stores are an embedding seam and may need initialization even
  // when config names the compatibility memory backend. Require initialize()
  // for every injected implementation; only the module-owned memory store is
  // known to be ready without it.
  let credentialRateLimitStoreInitialized =
    options.credentialRateLimitStore === undefined &&
    config.credentialRateLimitStore !== "dynamodb";
  // Bound completed-response teardown independently from active parser work.
  // A slow SDK close path can consume at most one additional concurrency pool.
  const {
    sessions,
    closingSessions,
    activeStatelessRequests,
    closingStatelessRequests,
    markSessionDisconnected,
    closeSession,
    sweepExpiredSessions,
    closeAllSessions,
    closeStatelessRequest,
    trackSessionActivity,
    getActiveSessionCount,
  } = createHttpSessionRegistry(config, withRequestAuth);

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) {
    app.set("trust proxy", config.trustProxyHops);
  }

  const mcpRateLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.mcpRateLimitPerMinute,
    // Pin express-rate-limit's IPv6 privacy-address aggregation policy rather
    // than inheriting a library-default change on upgrade.
    ipv6Subnet: 56,
    // `identifier` names the draft-8 RateLimit policy; request IP remains the
    // default key. The credential policy below supplies its own keyGenerator.
    identifier: "ip",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => rejectJsonRpc(res, 429, "Too many requests."),
  });
  const publicRoutes = createPublicHttpRoutes(config, options);
  const { streamPublicVideo, publicRouteRateLimiter } = publicRoutes;
  const healthRateLimiter = createPublicRateLimiter(config);
  function rejectOAuth(res: express.Response, error: unknown): void {
    if (res.destroyed) return;
    if (error instanceof OAuthServerError) {
      res.set("Retry-After", "1");
      rejectJsonRpc(res, 503, "Delegated authentication is temporarily unavailable.");
      return;
    }
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl}"${error === undefined ? "" : ', error="invalid_token", error_description="Reconnect your account."'}`,
    );
    rejectJsonRpc(res, 401, "Invalid or unavailable delegated access. Reconnect your account.");
  }
  const verifyBearer: express.RequestHandler = oauth
    ? async (req, res, next) => {
        try {
          const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
          if (!match) {
            rejectOAuth(
              res,
              req.headers.authorization ? new Error("Malformed bearer header") : undefined,
            );
            return;
          }
          req.auth = await oauth.verifyAccessToken(match[1]);
          if (!res.destroyed) next();
        } catch (error) {
          rejectOAuth(res, error);
        }
      }
    : requireBearerAuth({
        verifier: createPassthroughBearerVerifier(),
        requiredScopes: ["mcp:tools"],
      });
  const bearerAuthMiddleware: express.RequestHandler = oauth
    ? (req, res, next) => {
        const work = Promise.resolve(
          verifyBearer(req, res, () => {
            if (!res.destroyed) next();
          }),
        );
        (res.locals as McpResponseLocals).oauthWork = work;
        void work.catch(next);
      }
    : verifyBearer;
  const concurrencyLimiter: express.RequestHandler = (_req, res, next) => {
    if (
      inFlightRequests >= maxConcurrentRequests ||
      closingStatelessRequests.size >= maxConcurrentRequests
    ) {
      // This is an admission-failure metric, not a pure active-work gauge: a
      // saturated teardown backlog is also capacity loss and should page. The
      // autoscaling policy uses McpConcurrencyUtilization alone, so teardown
      // lag cannot spuriously drive scaling from this counter.
      metrics.incrementConcurrencyRejected();
      rejectJsonRpc(res, 503, "The MCP request concurrency limit has been reached.");
      return;
    }
    inFlightRequests += 1;
    metrics.observeConcurrencyUtilization();
    let released = false;
    const releasePermit = (): void => {
      if (released) return;
      released = true;
      inFlightRequests -= 1;
    };
    const release = (): void => {
      // A disconnected client must not free capacity while OAuth work still runs.
      const work = (res.locals as McpResponseLocals).oauthWork;
      if (work) void work.then(releasePermit, releasePermit);
      else releasePermit();
    };
    // Release when the response lifetime ends: this permit bounds active body
    // parsing/request work, not asynchronously closing MCP objects. Teardown is
    // tracked separately in closingStatelessRequests and drained on shutdown.
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  const credentialRateLimiter: express.RequestHandler = async (req, res, next) => {
    const token = getAuthenticatedBearerToken(req);
    if (!token) {
      rejectJsonRpc(res, 401, "Bearer authentication required.");
      return;
    }
    try {
      const windowStartedAtMs = Date.now();
      const credentialDigest = digestBearerToken(token).toString("hex");
      const count = await credentialRateLimitStore.increment({
        credentialDigest,
        windowStartedAtMs,
      });
      const remaining = Math.max(0, config.mcpRateLimitPerMinute - count);
      const resetSeconds = Math.max(1, Math.ceil((60_000 - (windowStartedAtMs % 60_000)) / 1_000));
      appendStructuredHeader(res, "RateLimit", `"credential"; r=${remaining}; t=${resetSeconds}`);
      appendStructuredHeader(
        res,
        "RateLimit-Policy",
        `"credential"; q=${config.mcpRateLimitPerMinute}; w=60`,
      );
      if (count > config.mcpRateLimitPerMinute) {
        rejectJsonRpc(res, 429, "Too many requests.");
        return;
      }
      next();
    } catch (error) {
      metrics.incrementRateLimitStoreErrors();
      console.error(`[mcp-http] credential rate-limit store failed (${formatErrorForLog(error)})`);
      rejectJsonRpc(res, 503, "Credential rate-limit service is unavailable.");
    }
  };
  // The credential guard and limiter core are one middleware, so a future
  // array reorder cannot make tokenless requests reach the keyed store.
  // Preserve the existing stateful contract: POST, SSE GET, and explicit
  // DELETE all consume the process-local credential quota. Stateless GET and
  // DELETE are unsupported probes and bypass the fleet-wide store below.
  const authenticatedMcpMiddleware = [bearerAuthMiddleware, credentialRateLimiter];
  const authenticatedMcpPostMiddleware = [
    ...(stateless && oauth ? [concurrencyLimiter] : []),
    bearerAuthMiddleware,
    ...(stateless && !oauth ? [concurrencyLimiter] : []),
    credentialRateLimiter,
  ];
  const rejectUnsupportedStatelessMethod =
    (method: "GET" | "DELETE"): express.RequestHandler =>
    (_req, res) => {
      res.set("Allow", "POST");
      rejectJsonRpc(res, 405, `${method} is not supported in stateless HTTP mode.`, -32600);
    };

  // Readiness must not depend on the public Host allowlist: ALB probes use the
  // target IP and port as Host. The response carries no state and has no side
  // effects; keep both properties true before expanding this exemption.
  // /healthz is intentionally unauthenticated and Host-unvalidated for every
  // caller, not only ALB-shaped Host values.
  app.get(HEALTH_HTTP_PATH, healthRateLimiter, (_req, res) => {
    res.json({ ok: true });
  });

  if (config.allowedHosts?.length) {
    app.use(hostHeaderValidation(config.allowedHosts));
  } else {
    app.use(localhostHostValidation());
  }
  if (oauth) {
    app.get(
      [OAUTH_RESOURCE_METADATA_PATH, `${OAUTH_RESOURCE_METADATA_PATH}/mcp`],
      publicRouteRateLimiter,
      (_req, res) => {
        res.json({
          resource: OAUTH_RESOURCE,
          authorization_servers: [OAUTH_ISSUER],
          scopes_supported: OAUTH_SCOPES,
          bearer_methods_supported: ["header"],
        });
      },
    );
  }
  // Host validation may admit aliases for routing, but browser-originated MCP
  // requests intentionally use the single canonical public origin in baseUrl.
  // Do not widen this check merely because allowedHosts contains extra names.
  const allowedOrigin = new URL(baseUrl).origin;
  // This is the complete stateful browser-route set today. Add any future
  // state-changing browser route here rather than assuming this check is global.
  app.use((req, res, next) => {
    if (req.path !== MCP_HTTP_PATH && req.path !== `${MCP_HTTP_PATH}/`) {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    try {
      if (typeof origin === "string" && new URL(origin).origin === allowedOrigin) {
        next();
        return;
      }
    } catch {
      // Reject malformed Origin values with the same bounded response.
    }
    res.status(403).send("Origin is not allowed.");
  });

  const parseConfiguredMcpJsonBody = express.json({
    limit: getJsonBodyLimitBytes(config.maxUploadFileDataBytes),
    strict: true,
  });
  const parseUnvalidatedMcpJsonBody = express.json({
    limit: getJsonBodyLimitBytes(
      Math.min(config.maxUploadFileDataBytes, DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES),
    ),
    strict: true,
  });

  let pendingInitializations = 0;
  const pendingInitializationsByCredential = new Map<string, number>();

  const parseMcpJsonBody: express.RequestHandler = (req, res, next) => {
    const bearerToken = getAuthenticatedBearerToken(req);
    const session = sessions.get(getSessionId(req) ?? "");
    const mayUseConfiguredLimit =
      stateless ||
      (session?.credentialValidated === true &&
        bearerToken !== undefined &&
        bearerTokenMatches(bearerToken, session.bearerTokenDigest));
    // Session lookup alone is not authorization: in stateful mode the digest
    // re-check prevents a guessed or leaked session ID from unlocking the
    // larger parser ceiling. Stateless mode has no session to validate, so its
    // configured parser ceiling is instead bounded by the permit acquired
    // before parsing. This is a memory-amplification gate, not a qURL scope
    // boundary; each operation still enforces its downstream scopes.
    const locals = res.locals as McpResponseLocals;
    locals.usingUnvalidatedBodyLimit = !mayUseConfiguredLimit;
    const parser = mayUseConfiguredLimit ? parseConfiguredMcpJsonBody : parseUnvalidatedMcpJsonBody;
    parser(req, res, next);
  };

  function getSessionId(req: IncomingMessage): string | undefined {
    const header = req.headers["mcp-session-id"];
    return typeof header === "string" ? header : undefined;
  }

  function formatDurationMs(startedAt: number): string {
    return `${Date.now() - startedAt}ms`;
  }

  function getAuthenticatedBearerToken(req: express.Request): string | undefined {
    // Narrow the SDK-installed field locally instead of depending on its
    // ambient Express Request augmentation remaining source-compatible.
    const auth = (req as express.Request & { auth?: unknown }).auth;
    if (typeof auth !== "object" || auth === null || !("token" in auth)) return undefined;
    return typeof auth.token === "string" ? canonicalizeBearerToken(auth.token) : undefined;
  }

  function digestBearerToken(token: string): Buffer {
    return createHash("sha256").update(token, "utf8").digest();
  }

  function bearerTokenMatches(token: string, expectedDigest: Buffer): boolean {
    return timingSafeEqual(digestBearerToken(token), expectedDigest);
  }

  function getToolCapabilities(bearerToken: string) {
    // Upload routing is fixed for this runtime; SMTP configuration can refresh.
    const uploads = Boolean(defaultQurlConnectorUrl);
    try {
      const runtimeConfig = loadRuntimeConfig(runtimeConfigPath);
      return {
        uploads,
        email:
          Boolean(runtimeConfig.smtp) &&
          isHttpEmailAuthorized(bearerToken, runtimeConfig.qurlApiKey),
      };
    } catch (error) {
      // A malformed SMTP edit must not take unrelated MCP tools offline.
      console.error(`Email discovery disabled (${formatErrorForLog(error)})`);
      return { uploads, email: false };
    }
  }

  function getJsonRpcMethod(body: unknown): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    return "method" in body && typeof body.method === "string" ? body.method : undefined;
  }

  function containsInitializeRequest(body: unknown): boolean {
    return Array.isArray(body)
      ? body.some((message) => isInitializeRequest(message))
      : isInitializeRequest(body);
  }

  function isExclusiveInitializeRequest(body: unknown): boolean {
    return Array.isArray(body)
      ? body.length === 1 && isInitializeRequest(body[0])
      : isInitializeRequest(body);
  }

  function containsToolCall(body: unknown): boolean {
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((message) => getJsonRpcMethod(message) === "tools/call");
  }

  function rejectJsonRpc(
    res: ServerResponse,
    statusCode: number,
    message: string,
    code = -32000,
  ): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code,
          message,
        },
        id: null,
      }),
    );
  }

  const REINITIALIZE_MESSAGE =
    "Session not found. The MCP server may have restarted. Please re-initialize the MCP connection.";

  function logMissingSession(): void {
    console.warn("[mcp-http] session missing; client must re-initialize");
  }

  function findAuthorizedSession(req: express.Request): AuthorizedSession | undefined {
    const sessionId = getSessionId(req);
    const bearerToken = getAuthenticatedBearerToken(req);
    const session = sessions.get(sessionId ?? "");
    if (!session) return undefined;
    if (!bearerToken || !bearerTokenMatches(bearerToken, session.bearerTokenDigest)) {
      return undefined;
    }
    return { session, bearerToken };
  }

  function resolveAuthorizedSession(req: express.Request): AuthorizedSession | undefined {
    const authorizedSession = findAuthorizedSession(req);
    if (!authorizedSession) {
      // Use the same 404 response and operator log for an unknown ID and a
      // credential mismatch, so neither surface becomes a session oracle.
      logMissingSession();
    }
    return authorizedSession;
  }

  function withRequestAuth<T>(
    sessionId: string | undefined,
    qurlApiKey: string,
    fn: () => Promise<T>,
  ) {
    return runWithRequestAuthContext(
      {
        sessionId: sessionId ?? "(none)",
        qurlApiKey,
        qurlConnectorUrl: defaultQurlConnectorUrl,
        maxUploadFileDataBytes: config.maxUploadFileDataBytes,
        markCredentialValidated: sessionId
          ? () => {
              const session = sessions.get(sessionId);
              if (session) session.credentialValidated = true;
            }
          : undefined,
      },
      fn,
    );
  }

  const handleStatelessMcpPost: express.RequestHandler = async (req, res) => {
    let bearerToken = getAuthenticatedBearerToken(req);
    const startedAt = Date.now();
    const hasToolCall = containsToolCall(req.body);
    if (!bearerToken) {
      rejectJsonRpc(res, 401, "Bearer authentication required.");
      return;
    }

    let delegatedScopes: string[] | undefined;
    if (oauth) {
      if (res.destroyed) return;
      try {
        const work = oauth.delegate(req.auth!);
        (res.locals as McpResponseLocals).oauthWork = work;
        const delegated = await work;
        if (res.destroyed) return;
        bearerToken = delegated.token;
        delegatedScopes = delegated.scopes;
        const redactionScope = `http-oauth:${randomUUID()}`;
        registerSensitiveLogValues(redactionScope, [req.auth!.token, bearerToken]);
        const clearRedaction = () => clearSensitiveLogValues(redactionScope);
        res.once("finish", clearRedaction);
        res.once("close", clearRedaction);
      } catch (error) {
        rejectOAuth(res, error);
        return;
      }
    }

    // Stateless transports deliberately ignore caller-provided affinity.
    delete req.headers["mcp-session-id"];
    const server = createServer(
      options.clientFactory?.(bearerToken) ??
        createQurlClientFromBearerToken(bearerToken, { qurlApiUrl: defaultQurlApiUrl }),
      version,
      "http",
      config.maxUploadFileDataBytes,
      {
        ...getToolCapabilities(bearerToken),
        ...(oauth
          ? { email: false, oauth: { scopes: delegatedScopes!, resourceMetadataUrl } }
          : {}),
      },
    );
    const transport =
      options.transportFactory?.(true) ??
      new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const request: StatelessRequestContext = { server, transport, bearerToken };
    activeStatelessRequests.add(request);
    let cleanupStarted = false;
    const cleanup = (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      void closeStatelessRequest(request);
    };
    res.once("finish", cleanup);
    res.once("close", cleanup);

    try {
      if (hasToolCall) logInfo("[mcp-http] stateless tool call started");
      await server.connect(transport);
      await withRequestAuth(undefined, bearerToken, () =>
        transport.handleRequest(req, res, req.body),
      );
      if (hasToolCall) {
        logInfo(`[mcp-http] stateless tool call finished elapsed=${formatDurationMs(startedAt)}`);
      }
      if (res.writableEnded) cleanup();
    } catch (error) {
      if (hasToolCall) {
        console.error(
          `[mcp-http] stateless tool call failed elapsed=${formatDurationMs(startedAt)}`,
        );
      }
      console.error(`Error handling stateless MCP POST request (${formatErrorForLog(error)})`);
      if (!res.headersSent) rejectJsonRpc(res, 500, "Internal server error.");
      cleanup();
    }
  };

  const handleMcpPost: express.RequestHandler = async (req, res) => {
    const bearerToken = getAuthenticatedBearerToken(req);
    const startedAt = Date.now();
    const hasToolCall = containsToolCall(req.body);

    if (!bearerToken) {
      rejectJsonRpc(res, 401, "Bearer authentication required.");
      return;
    }

    try {
      const containsInitialize = containsInitializeRequest(req.body);
      if (containsInitialize && !isExclusiveInitializeRequest(req.body)) {
        rejectJsonRpc(res, 400, "Initialize must be sent as the only JSON-RPC message.");
        return;
      }
      if (containsInitialize) {
        const bearerTokenDigest = digestBearerToken(bearerToken);
        const credentialKey = bearerTokenDigest.toString("hex");
        await sweepExpiredSessions();
        let oldestIdle: SessionContext | undefined;
        let unvalidatedSessionCount = 0;
        let credentialSessionCount = 0;
        for (const session of sessions.values()) {
          if (!session.credentialValidated) {
            unvalidatedSessionCount += 1;
            if (!oldestIdle && session.activeRequests === 0) oldestIdle = session;
          }
          if (session.bearerTokenDigest.equals(bearerTokenDigest)) credentialSessionCount += 1;
        }
        const pendingForCredential = pendingInitializationsByCredential.get(credentialKey) ?? 0;
        if (credentialSessionCount + pendingForCredential >= config.maxSessionsPerCredential) {
          rejectJsonRpc(
            res,
            503,
            "The per-credential MCP session limit has been reached. Close an existing session or try again later.",
          );
          return;
        }
        if (unvalidatedSessionCount + pendingInitializations >= config.maxUnvalidatedSessions) {
          // Unverified bearers must not reserve every admission slot until TTL.
          // Map insertion order selects the oldest idle, unvalidated session.
          // Bound asynchronous teardown too; never evict active or validated work.
          if (!oldestIdle || closingSessions.size >= config.maxUnvalidatedSessions) {
            rejectJsonRpc(
              res,
              503,
              "The pending MCP credential-validation limit has been reached. Try again later.",
            );
            return;
          }
          // closeSession removes the entry synchronously before its first await.
          // Reserve its replacement below without yielding to another initializer.
          void closeSession(oldestIdle.sessionId);
        }
        if (sessions.size + pendingInitializations >= config.maxSessions) {
          rejectJsonRpc(res, 503, "The MCP session limit has been reached. Try again later.");
          return;
        }

        // Reserve both a live-session slot and an unvalidated-session slot
        // plus the caller's per-credential slot before the first initialization
        // await. Keep the cap checks through these increments free of await
        // points so concurrent requests cannot overshoot any configured cap.
        pendingInitializations += 1;
        pendingInitializationsByCredential.set(credentialKey, pendingForCredential + 1);

        try {
          // Initialization always creates a fresh session. Discard any supplied
          // session header before handing the request to the MCP transport so a
          // caller cannot use header presence to select a privileged code path.
          delete req.headers["mcp-session-id"];

          const server = createServer(
            options.clientFactory?.(bearerToken) ??
              createQurlClientFromBearerToken(bearerToken, { qurlApiUrl: defaultQurlApiUrl }),
            version,
            "http",
            config.maxUploadFileDataBytes,
            getToolCapabilities(bearerToken),
          );
          const transport =
            options.transportFactory?.() ??
            new StreamableHTTPServerTransport({
              // The SDK's duplicate Host/Origin options are deprecated in
              // favor of external middleware. Our checks run globally before
              // auth, parsing, or any route can reach this transport.
              sessionIdGenerator: () => randomUUID(),
            });
          let closedBeforeRegistration = false;

          transport.onclose = () => {
            if (!transport.sessionId || !sessions.has(transport.sessionId)) {
              closedBeforeRegistration = true;
              return;
            }
            // Some clients/proxies reconnect the GET SSE stream with the same
            // session ID. Deleting the in-memory session record here can cause
            // a subsequent GET /mcp to be rejected as "unknown session" even
            // though the client is attempting a valid reconnect. Explicit DELETE
            // requests still remove sessions from the registry. A short grace
            // period bounds how long a disconnected session remains available.
            markSessionDisconnected(transport.sessionId);
          };

          try {
            await server.connect(transport);
            await withRequestAuth(undefined, bearerToken, () =>
              transport.handleRequest(req, res, req.body),
            );
          } catch (error) {
            await server.close().catch((closeError: unknown) => {
              console.error(
                `[mcp-http] initialize cleanup failed (${formatErrorForLog(closeError)})`,
              );
            });
            throw error;
          }

          if (!transport.sessionId || closedBeforeRegistration) {
            console.warn(
              closedBeforeRegistration
                ? "[mcp-http] initialize transport closed before session registration"
                : "[mcp-http] initialize completed without session id",
            );
            await server.close();
            return;
          }

          const createdAt = Date.now();
          registerSensitiveLogValues(`http-session:${transport.sessionId}`, [bearerToken]);
          sessions.set(transport.sessionId, {
            sessionId: transport.sessionId,
            transport,
            server,
            bearerTokenForRedaction: bearerToken,
            bearerTokenDigest,
            createdAt,
            lastActivityAt: createdAt,
            activeRequests: 0,
            credentialValidated: false,
          });
          logInfo(`[mcp-http] initialize completed elapsed=${formatDurationMs(startedAt)}`);
          return;
        } finally {
          pendingInitializations -= 1;
          const remainingForCredential =
            (pendingInitializationsByCredential.get(credentialKey) ?? 1) - 1;
          if (remainingForCredential === 0) {
            pendingInitializationsByCredential.delete(credentialKey);
          } else {
            pendingInitializationsByCredential.set(credentialKey, remainingForCredential);
          }
        }
      }

      const authorizedSession = resolveAuthorizedSession(req);
      if (!authorizedSession) {
        rejectJsonRpc(res, 404, REINITIALIZE_MESSAGE);
        return;
      }
      const { session, bearerToken: sessionBearerToken } = authorizedSession;

      if (hasToolCall) logInfo("[mcp-http] tool call started");
      await trackSessionActivity(session, () =>
        withRequestAuth(session.sessionId, sessionBearerToken, () =>
          session.transport.handleRequest(req, res, req.body),
        ),
      );
      if (hasToolCall)
        logInfo(`[mcp-http] tool call finished elapsed=${formatDurationMs(startedAt)}`);
    } catch (error) {
      if (hasToolCall) {
        console.error(`[mcp-http] tool call failed elapsed=${formatDurationMs(startedAt)}`);
      }
      console.error(`Error handling MCP POST request (${formatErrorForLog(error)})`);
      if (!res.headersSent) {
        // Keep every unexpected transport failure identical. Branching on a
        // caller-provided session ID or bearer here would reintroduce a
        // session-existence oracle on the error path.
        rejectJsonRpc(res, 500, "Internal server error.");
      }
    }
  };

  app.post(
    MCP_HTTP_PATH,
    mcpRateLimiter,
    ...authenticatedMcpPostMiddleware,
    parseMcpJsonBody,
    stateless ? handleStatelessMcpPost : handleMcpPost,
  );

  app.get(
    MCP_HTTP_PATH,
    // Keep unsupported stateless probes in the cheap per-IP bucket so they
    // cannot flood 405 responses; the credential/DynamoDB limiter is bypassed.
    mcpRateLimiter,
    ...(stateless ? [rejectUnsupportedStatelessMethod("GET")] : authenticatedMcpMiddleware),
    async (req, res) => {
      const authorizedSession = resolveAuthorizedSession(req);
      if (!authorizedSession) {
        res.status(404).send(REINITIALIZE_MESSAGE);
        return;
      }
      const { session, bearerToken } = authorizedSession;
      // The SDK transport can remain reusable after its SSE response closes, so
      // track the response lifecycle directly rather than relying only on the
      // transport-level onclose hook.
      res.once("close", () => markSessionDisconnected(session.sessionId));

      try {
        await trackSessionActivity(session, () =>
          withRequestAuth(session.sessionId, bearerToken, () =>
            session.transport.handleRequest(req, res),
          ),
        );
      } catch (error) {
        console.error(`Error handling MCP GET request (${formatErrorForLog(error)})`);
        if (!res.headersSent) {
          res.status(500).send("Internal server error.");
        }
      }
    },
  );

  app.delete(
    MCP_HTTP_PATH,
    // Match GET: rate-limit probes by IP without charging a bearer counter.
    mcpRateLimiter,
    ...(stateless ? [rejectUnsupportedStatelessMethod("DELETE")] : authenticatedMcpMiddleware),
    async (req, res) => {
      const authorizedSession = resolveAuthorizedSession(req);
      if (!authorizedSession) {
        res.status(404).send(REINITIALIZE_MESSAGE);
        return;
      }
      const { session, bearerToken } = authorizedSession;

      try {
        logInfo("[mcp-http] closing session");
        session.lastActivityAt = Date.now();
        await withRequestAuth(session.sessionId, bearerToken, () =>
          session.transport.handleRequest(req, res),
        );
      } catch (error) {
        console.error(`Error handling MCP DELETE request (${formatErrorForLog(error)})`);
        if (!res.headersSent) {
          res.status(500).send("Internal server error.");
        }
      } finally {
        // DELETE is an explicit teardown request. It intentionally closes the
        // transport even if another request is still in flight rather than
        // allowing a long-running tool call to block client-directed cleanup.
        // The SDK handles DELETE by closing the transport first; its Protocol
        // onclose hook then clears the server's transport reference. closeSession
        // removes our registry reference before calling server.close(), making
        // that final ownership cleanup idempotent and safe if SDK behavior changes.
        await closeSession(session.sessionId);
      }
    },
  );

  const jsonBodyErrorHandler: express.ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const bodyErrorStatus =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    const bodyErrorType =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      typeof error.type === "string"
        ? error.type
        : undefined;
    if (bodyErrorStatus === 413 || bodyErrorType === "entity.too.large") {
      const locals = res.locals as McpResponseLocals;
      rejectJsonRpc(
        res,
        413,
        locals.usingUnvalidatedBodyLimit &&
          config.maxUploadFileDataBytes > DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES
          ? "Request body is too large for an unvalidated session. Complete a smaller qURL API call first."
          : "Request body is too large.",
      );
      return;
    }
    if (error instanceof SyntaxError) {
      rejectJsonRpc(res, 400, "Request body must be valid JSON.", -32700);
      return;
    }
    if (bodyErrorStatus !== undefined && bodyErrorStatus >= 400 && bodyErrorStatus < 500) {
      rejectJsonRpc(res, bodyErrorStatus, "Request body could not be processed.");
      return;
    }
    console.error(`HTTP middleware failed (${formatErrorForLog(error)})`);
    rejectJsonRpc(res, 500, "Internal server error.");
  };

  publicRoutes.register(app);

  // Keep JSON-RPC error envelopes scoped to the protocol route. Public pages
  // use a plain-text fallback so an unrelated handler failure cannot return a
  // misleading JSON-RPC response (or Express's default stack-bearing HTML).
  app.use(MCP_HTTP_PATH, jsonBodyErrorHandler);
  app.use(((error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error(`Public HTTP middleware failed (${formatErrorForLog(error)})`);
    res.status(500).type("text").send("Internal server error.");
  }) satisfies express.ErrorRequestHandler);

  let shutdownHttpServer: (signal?: string) => void = () => undefined;

  async function initialize(): Promise<void> {
    await credentialRateLimitStore.initialize();
    credentialRateLimitStoreInitialized = true;
  }

  function startHttpServer(): Server {
    if (!credentialRateLimitStoreInitialized) {
      throw new Error("Credential rate-limit store must be initialized before HTTP startup.");
    }
    installTimestampedConsole();
    // Stateless loopback development keeps production interval semantics even
    // without an emitter. Stateful mode cannot configure metric identity and
    // does not schedule an idle heartbeat timer.
    const metricsTimer = stateless
      ? globalThis.setInterval(() => metrics.emitHeartbeat(), 30_000)
      : undefined;
    metricsTimer?.unref();
    if (stateless) metrics.emitHeartbeat();
    let sweepInProgress = false;
    const shortestSessionTtlMs = Math.min(
      config.sessionIdleTtlMs,
      config.sessionAbsoluteTtlMs,
      config.unvalidatedSessionTtlMs,
    );
    const sweepTimer = !stateless
      ? globalThis.setInterval(
          () => {
            if (sweepInProgress) return;
            sweepInProgress = true;
            void sweepExpiredSessions()
              .catch((error: unknown) => {
                console.error(`[mcp-http] session sweep failed (${formatErrorForLog(error)})`);
              })
              .finally(() => {
                sweepInProgress = false;
              });
          },
          Math.min(60_000, Math.max(5_000, Math.floor(shortestSessionTtlMs / 2))),
        )
      : undefined;
    sweepTimer?.unref();

    const httpServer = app.listen(port, host, () => {
      logInfo(`qURL MCP HTTP server listening on ${sanitizeLogValue(host)}:${port}`);
      logInfo(
        `HTTP MCP auth mode: ${oauth ? "Auth0 OAuth with per-user delegation" : "qURL API-key passthrough"}`,
      );
      if (config.maxUploadFileDataBytes > DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES) {
        console.warn(
          stateless
            ? "Warning: maxUploadFileDataBytes exceeds the default; stateless requests may use the configured parser ceiling before downstream bearer validation. Apply an authenticated edge request-size limit on hostile networks."
            : "Warning: maxUploadFileDataBytes exceeds the default; requests above the default parser ceiling require an already-validated MCP session. Apply an authenticated edge request-size limit on hostile networks.",
        );
      }
      if (
        stateless &&
        config.credentialRateLimitStore !== "dynamodb" &&
        options.credentialRateLimitStore === undefined
      ) {
        console.warn(
          "Warning: stateless HTTP is using the process-local memory credential quota. This is supported only for single-process loopback development; any load-balanced or multi-replica deployment requires DynamoDB.",
        );
      }
      if (config.trustProxyHops === 0 && !isLoopbackHostname(host)) {
        console.warn(
          "Warning: non-loopback HTTP listener has trustProxyHops=0, which is valid only for direct connections. Clients behind a reverse proxy will share the proxy's rate-limit bucket; set the exact trusted hop count.",
        );
      }
      logInfo("HTTP and runtime config loaded.");
      publicRoutes.logStartupStatus();
      if (defaultQurlConnectorUrl) logInfo("qURL Connector uploads enabled.");
      const smtpInspection = inspectSmtpConfig(runtimeConfigPath);
      logInfo(
        smtpInspection.enabled
          ? "SMTP is configured."
          : `SMTP is not configured. Missing fields: ${smtpInspection.missingFields.join(", ") || "(unknown)"}`,
      );
      if (smtpInspection.enabled) {
        logInfo(
          loadRuntimeConfig(runtimeConfigPath).qurlApiKey
            ? "HTTP email delivery is restricted to the operator credential."
            : "HTTP email delivery is disabled: QURL_API_KEY is not configured.",
        );
      }
      for (const warning of smtpInspection.securityWarnings) console.warn(`Warning: ${warning}`);
      if (config.allowedHosts?.length) {
        logInfo(`Host allowlist enabled with ${config.allowedHosts.length} entries.`);
      }
    });
    if (stateless) {
      // A permit spans parsing through response completion. Bound slow header,
      // body, and idle-response sockets so a small set of stalled connections
      // cannot retain the whole stateless permit pool indefinitely.
      httpServer.headersTimeout = STATELESS_HEADERS_TIMEOUT_MS;
      httpServer.requestTimeout = STATELESS_REQUEST_TIMEOUT_MS;
      httpServer.setTimeout(STATELESS_SOCKET_IDLE_TIMEOUT_MS);
    }

    let shuttingDown = false;
    const removeSignalHandlers = (): void => {
      process.removeListener("SIGTERM", handleSigterm);
      process.removeListener("SIGINT", handleSigint);
    };
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (sweepTimer) globalThis.clearInterval(sweepTimer);
      if (metricsTimer) globalThis.clearInterval(metricsTimer);
      // Preserve the trailing partial interval before ECS scale-in or a
      // rolling replacement terminates the process.
      if (stateless) metrics.emitHeartbeat();
      removeSignalHandlers();
      logInfo(`Received ${signal}; draining HTTP connections and MCP sessions.`);

      const forceCloseTimer = globalThis.setTimeout(() => {
        httpServer.closeAllConnections();
      }, 10_000);
      forceCloseTimer.unref();

      httpServer.close((error) => {
        void closeAllSessions().finally(() => {
          globalThis.clearTimeout(forceCloseTimer);
          if (error) {
            console.error(`HTTP server shutdown failed (${formatErrorForLog(error)})`);
            process.exitCode = 1;
          }
        });
      });
    };

    const handleSigterm = (): void => shutdown("SIGTERM");
    const handleSigint = (): void => shutdown("SIGINT");
    process.once("SIGTERM", handleSigterm);
    process.once("SIGINT", handleSigint);
    httpServer.once("close", () => {
      if (sweepTimer) globalThis.clearInterval(sweepTimer);
      if (metricsTimer) globalThis.clearInterval(metricsTimer);
      removeSignalHandlers();
    });
    shutdownHttpServer = (signal = "shutdown") => shutdown(signal);
    return httpServer;
  }

  return {
    // start/close are embedding APIs; the observation, streaming, and sweep
    // hooks are intentionally exposed as deterministic test seams.
    app,
    closeAllSessions,
    emitMetricsHeartbeat: () => metrics.emitHeartbeat(),
    getActiveSessionCount,
    // Stateless-only observation seam; stateful runtimes intentionally report
    // zero because they do not acquire the pre-parser concurrency permit.
    getInFlightRequestCount: () => inFlightRequests,
    initialize,
    shutdownHttpServer: (signal?: string) => shutdownHttpServer(signal),
    startHttpServer,
    streamPublicVideo,
    sweepExpiredSessions,
  };
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
export async function runHttpMain(
  start = async (): Promise<void> => {
    const require = createRequire(import.meta.url);
    const { version } = require("../package.json") as { version: string };
    const runtimeConfigPath = getDefaultConfigPath();
    const config = loadHttpServerConfig(getDefaultHttpConfigPath());
    const runtime = createHttpRuntime(config, { runtimeConfigPath, version });
    await runtime.initialize();
    runtime.startHttpServer();
  },
): Promise<void> {
  const handleStartupError = (error: unknown): void => {
    installTimestampedConsole();
    console.error(`qURL MCP HTTP startup failed (${formatErrorForLog(error)})`);
    // Startup failed before a server or sweep timer was retained. Preserve
    // stderr flushing and let the empty event loop terminate with this status.
    process.exitCode = 1;
  };
  try {
    await start();
  } catch (error) {
    handleStartupError(error);
  }
}

if (isMainModule) void runHttpMain();
