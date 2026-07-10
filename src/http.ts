#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatErrorForLog,
  installTimestampedConsole,
  logInfo,
  sanitizeLogValue,
} from "./logging.js";
import express from "express";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { rateLimit } from "express-rate-limit";
import { runWithRequestAuthContext } from "./auth/request-context.js";
import type { IQURLClient } from "./client.js";
import {
  createPassthroughBearerVerifier,
  createQurlClientFromBearerToken,
} from "./auth/static-bearer.js";
import {
  DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES,
  getDefaultConfigPath,
  inspectSmtpConfig,
  isLoopbackHostname,
} from "./config.js";
import {
  getDefaultHttpConfigPath,
  loadHttpServerConfig,
  type HttpServerConfig,
} from "./http-config.js";
import { getLegalDocuments, renderLegalDocumentHtml } from "./services/legal-pages.js";
import { getPublicVideoFileRoute, renderPublicVideoPageHtml } from "./services/video-page.js";
import { createServer } from "./server.js";

type SessionContext = {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
  // The per-session client already retains this credential for downstream
  // calls. Keep the same value here only so asynchronous teardown errors run
  // through exact-credential redaction; never render or expose it.
  bearerTokenForRedaction: string;
  bearerTokenDigest: Buffer;
  createdAt: number;
  lastActivityAt: number;
  activeRequests: number;
  credentialValidated: boolean;
  disconnectedAt?: number;
};

type AuthorizedSession = {
  session: SessionContext;
  bearerToken: string;
};

const DISCONNECTED_SESSION_GRACE_MS = 30_000;

function getJsonBodyLimitBytes(maxUploadFileDataBytes: number): number {
  // This limits raw request bytes, so JSON escaping can only consume the
  // allowance faster; it cannot expand memory beyond this parser ceiling.
  // Base64 itself needs no JSON escaping and inflates decoded bytes by 4/3,
  // leaving the remainder of this 1.5x bound for the JSON-RPC envelope.
  // decodeBase64File still applies the exact decoded-byte limit after parsing.
  return Math.ceil(maxUploadFileDataBytes * 1.5) + 64 * 1024;
}

export interface HttpRuntimeOptions {
  clientFactory?: (bearerToken: string) => IQURLClient;
  fileStreamFactory?: (
    filePath: string,
    options: { start?: number; end?: number },
  ) => ReturnType<typeof createReadStream>;
  transportFactory?: () => StreamableHTTPServerTransport;
  runtimeConfigPath?: string;
  version: string;
}

interface McpResponseLocals {
  usingUnvalidatedBodyLimit?: boolean;
}

export function createHttpRuntime(config: HttpServerConfig, options: HttpRuntimeOptions) {
  const runtimeConfigPath = options.runtimeConfigPath ?? getDefaultConfigPath();
  const version = options.version;
  const port = config.port;
  const host = config.host;
  const baseUrl = config.baseUrl;
  const defaultQurlApiUrl = config.defaultQurlApiUrl;
  const defaultQurlConnectorUrl = config.defaultQurlConnectorUrl;

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) {
    app.set("trust proxy", config.trustProxyHops);
  }

  const mcpRateLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.mcpRateLimitPerMinute,
    // `identifier` names the draft-8 RateLimit policy; request IP remains the
    // default key. The credential policy below supplies its own keyGenerator.
    identifier: "ip",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => rejectJsonRpc(res, 429, "Too many requests."),
  });
  const credentialRateLimiter = rateLimit({
    windowMs: 60_000,
    // The matching threshold is intentional: the IP policy bounds aggregate
    // traffic from one network (including shared egress), while this policy
    // follows one credential even if it rotates source addresses. Requests
    // must satisfy both independent abuse controls.
    limit: config.mcpRateLimitPerMinute,
    identifier: "credential",
    keyGenerator: (req) => {
      const token = getAuthenticatedBearerToken(req);
      // Bearer middleware runs first, so "missing" is a fail-closed fallback
      // for unexpected middleware composition rather than a normal route.
      return token ? digestBearerToken(token).toString("hex") : "missing";
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => rejectJsonRpc(res, 429, "Too many requests."),
  });
  const createPublicRateLimiter = () =>
    rateLimit({
      windowMs: 60_000,
      limit: config.publicFileRateLimitPerMinute,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).send("Too many requests.");
      },
    });
  // Legal documents and the video page share an aggregate browser-page bucket.
  // Video byte-range traffic and health probes use isolated instances so
  // playback and liveness checks cannot starve the public documents.
  const publicRouteRateLimiter = createPublicRateLimiter();
  const videoFileRateLimiter = createPublicRateLimiter();
  const healthRateLimiter = createPublicRateLimiter();
  const bearerAuthMiddleware = requireBearerAuth({
    verifier: createPassthroughBearerVerifier(),
    requiredScopes: ["mcp:tools"],
  });
  const authenticatedMcpMiddleware = [bearerAuthMiddleware, credentialRateLimiter];

  if (config.allowedHosts?.length) {
    app.use(hostHeaderValidation(config.allowedHosts));
  } else {
    app.use(localhostHostValidation());
  }
  // Host validation may admit aliases for routing, but browser-originated MCP
  // requests intentionally use the single canonical public origin in baseUrl.
  // Do not widen this check merely because allowedHosts contains extra names.
  const allowedOrigin = new URL(baseUrl).origin;
  // This is the complete stateful browser-route set today. Add any future
  // state-changing browser route here rather than assuming this check is global.
  app.use((req, res, next) => {
    if (req.path !== "/mcp") {
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

  const sessions = new Map<string, SessionContext>();
  let pendingInitializations = 0;
  const pendingInitializationsByCredential = new Map<string, number>();

  const parseMcpJsonBody: express.RequestHandler = (req, res, next) => {
    const bearerToken = getAuthenticatedBearerToken(req);
    const session = sessions.get(getSessionId(req) ?? "");
    const mayUseConfiguredLimit =
      session?.credentialValidated === true &&
      bearerToken !== undefined &&
      bearerTokenMatches(bearerToken, session.bearerTokenDigest);
    // Session lookup alone is not authorization: the digest re-check prevents
    // a guessed or leaked session ID from unlocking the larger parser ceiling.
    // This is a memory-amplification gate, not a qURL scope boundary. Any key
    // authenticated by a successful API call may use the configured parser;
    // each subsequent operation still enforces its own downstream scopes.
    const locals = res.locals as McpResponseLocals;
    locals.usingUnvalidatedBodyLimit = !mayUseConfiguredLimit;
    const parser = mayUseConfiguredLimit ? parseConfiguredMcpJsonBody : parseUnvalidatedMcpJsonBody;
    parser(req, res, next);
  };

  function markSessionDisconnected(sessionId: string | undefined): void {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const disconnectedAt = Date.now();
    session.lastActivityAt = disconnectedAt;
    session.disconnectedAt = disconnectedAt;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await withRequestAuth(session.sessionId, session.bearerTokenForRedaction, async () => {
      try {
        await session.server.close();
      } catch (error) {
        // Format while the credential-scoped redaction context is still active.
        console.error(`[mcp-http] session close failed (${formatErrorForLog(error)})`);
      }
    });
  }

  async function sweepExpiredSessions(now = Date.now()): Promise<number> {
    const expiredIds = [...sessions.values()]
      .filter((session) => {
        if (now - session.createdAt >= config.sessionAbsoluteTtlMs) {
          // The absolute lifetime applies even to active tool/SSE requests so
          // keepalives cannot pin a validated session slot indefinitely.
          return true;
        }
        if (
          session.activeRequests === 0 &&
          session.disconnectedAt !== undefined &&
          now - session.disconnectedAt >=
            // A deliberately shorter configured idle TTL remains authoritative.
            Math.min(DISCONNECTED_SESSION_GRACE_MS, config.sessionIdleTtlMs)
        ) {
          return true;
        }
        if (!session.credentialValidated) {
          // The pending-session window is an absolute validation deadline.
          // Close even an active SSE stream so it cannot hold an unvalidated
          // slot indefinitely.
          return now - session.createdAt >= config.unvalidatedSessionTtlMs;
        }
        return (
          session.activeRequests === 0 && now - session.lastActivityAt >= config.sessionIdleTtlMs
        );
      })
      .map((session) => session.sessionId);
    await Promise.all(expiredIds.map((sessionId) => closeSession(sessionId)));
    return expiredIds.length;
  }

  async function closeAllSessions(): Promise<void> {
    await Promise.all([...sessions.keys()].map((sessionId) => closeSession(sessionId)));
  }

  async function trackSessionActivity<T>(
    session: SessionContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    session.lastActivityAt = Date.now();
    session.disconnectedAt = undefined;
    session.activeRequests += 1;
    try {
      return await fn();
    } finally {
      session.activeRequests -= 1;
      session.lastActivityAt = Date.now();
    }
  }

  function getActiveSessionCount(): number {
    return sessions.size;
  }

  function getSessionId(req: IncomingMessage): string | undefined {
    const header = req.headers["mcp-session-id"];
    return typeof header === "string" ? header : undefined;
  }

  function formatDurationMs(startedAt: number): string {
    return `${Date.now() - startedAt}ms`;
  }

  function getAuthenticatedBearerToken(req: express.Request): string | undefined {
    const token = req.auth?.token?.trim();
    return token ? token : undefined;
  }

  function digestBearerToken(token: string): Buffer {
    return createHash("sha256").update(token, "utf8").digest();
  }

  function bearerTokenMatches(token: string, expectedDigest: Buffer): boolean {
    return timingSafeEqual(digestBearerToken(token), expectedDigest);
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

  async function streamPublicVideo(
    req: express.Request,
    res: express.Response,
    filePath: string,
  ): Promise<void> {
    setPublicPageSecurityHeaders(res);
    let stats;
    try {
      stats = await stat(filePath);
    } catch (error) {
      console.error(`[public-video] file inspection failed (${formatErrorForLog(error)})`);
      res.status(404).send("Configured video file was not found.");
      return;
    }
    if (!stats.isFile() || stats.size === 0) {
      res.status(404).send("Configured video file was not found.");
      return;
    }

    const fileSize = stats.size;
    const range = req.headers.range;

    const pipeFile = (start?: number, end?: number): void => {
      const stream = options.fileStreamFactory
        ? options.fileStreamFactory(filePath, { start, end })
        : createReadStream(filePath, { start, end });
      const destroyStream = () => stream.destroy();
      res.once("close", destroyStream);
      stream.once("close", () => res.off("close", destroyStream));
      stream.once("error", (error) => {
        console.error(`[public-video] stream failed (${formatErrorForLog(error)})`);
        res.destroy(error);
      });
      stream.pipe(res);
    };

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.vary("Range");

    const rejectRange = (): void => {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      // Do not let a shared cache retain a malformed/unsatisfiable request's
      // response under the public representation's cache policy.
      res.setHeader("Cache-Control", "no-store");
      res.end();
    };

    if (!range) {
      res.setHeader("Content-Length", fileSize);
      pipeFile();
      return;
    }

    // Single ranges cover browser video playback. RFC 9110 permits a server to
    // reject unsupported multi-range requests, which we answer with 416.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      rejectRange();
      return;
    }

    const parsedStart = match[1] ? Number(match[1]) : undefined;
    const parsedEnd = match[2] ? Number(match[2]) : undefined;
    if (
      (parsedStart === undefined && parsedEnd === undefined) ||
      (parsedStart !== undefined && !Number.isSafeInteger(parsedStart)) ||
      (parsedEnd !== undefined && !Number.isSafeInteger(parsedEnd))
    ) {
      rejectRange();
      return;
    }

    let start = parsedStart ?? 0;
    let end = parsedEnd ?? fileSize - 1;

    if (parsedStart === undefined && parsedEnd !== undefined) {
      start = Math.max(fileSize - parsedEnd, 0);
      end = fileSize - 1;
    } else {
      // RFC 9110 treats an explicit last-byte position beyond the selected
      // representation as the representation's final byte.
      end = Math.min(end, fileSize - 1);
    }

    if (start < 0 || end < 0 || start >= fileSize || start > end) {
      rejectRange();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", chunkSize);
    pipeFile(start, end);
  }

  const REINITIALIZE_MESSAGE =
    "Session not found. The MCP server may have restarted. Please re-initialize the MCP connection.";

  function logMissingSession(): void {
    console.warn("[mcp-http] session missing; client must re-initialize");
  }

  function resolveAuthorizedSession(req: express.Request): AuthorizedSession | undefined {
    const sessionId = getSessionId(req);
    const bearerToken = getAuthenticatedBearerToken(req);
    const session = sessions.get(sessionId ?? "");
    if (!session) {
      logMissingSession();
      return undefined;
    }
    if (!bearerToken || !bearerTokenMatches(bearerToken, session.bearerTokenDigest)) {
      // Use the same 404 response as an unknown ID so callers cannot use the
      // endpoint or operator logs as a session-existence oracle across bearer
      // credentials.
      logMissingSession();
      return undefined;
    }
    return { session, bearerToken };
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
        if (sessions.size + pendingInitializations >= config.maxSessions) {
          rejectJsonRpc(res, 503, "The MCP session limit has been reached. Try again later.");
          return;
        }
        let unvalidatedSessionCount = 0;
        let credentialSessionCount = 0;
        for (const session of sessions.values()) {
          if (!session.credentialValidated) unvalidatedSessionCount += 1;
          if (session.bearerTokenDigest.equals(bearerTokenDigest)) credentialSessionCount += 1;
        }
        if (unvalidatedSessionCount + pendingInitializations >= config.maxUnvalidatedSessions) {
          rejectJsonRpc(
            res,
            503,
            "The pending MCP credential-validation limit has been reached. Try again later.",
          );
          return;
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
        const requestedSessionId = getSessionId(req);
        if (requestedSessionId && !sessions.has(requestedSessionId)) {
          rejectJsonRpc(res, 409, "Session closed during request. Please re-initialize.");
        } else {
          rejectJsonRpc(res, 500, "Internal server error.");
        }
      }
    }
  };

  app.post("/mcp", mcpRateLimiter, ...authenticatedMcpMiddleware, parseMcpJsonBody, handleMcpPost);

  app.get("/mcp", mcpRateLimiter, ...authenticatedMcpMiddleware, async (req, res) => {
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
  });

  app.delete("/mcp", mcpRateLimiter, ...authenticatedMcpMiddleware, async (req, res) => {
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
  });

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

  function getInlineStyleSources(html: string): string[] {
    // Page renderers must keep style blocks static. Interpolating request or
    // config data into CSS would make this live-content hash authorize it.
    return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
      (match) => `'sha256-${createHash("sha256").update(match[1], "utf8").digest("base64")}'`,
    );
  }

  function setPublicPageSecurityHeaders(
    res: express.Response,
    styleSources: string[] = [],
    allowSameOriginMedia = false,
  ): void {
    const stylePolicy = styleSources.length > 0 ? styleSources.join(" ") : "'none'";
    const mediaPolicy = allowSameOriginMedia ? "'self'" : "'none'";
    res.set({
      "Content-Security-Policy": `default-src 'none'; style-src ${stylePolicy}; img-src 'none'; media-src ${mediaPolicy}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
  }

  const legalDocuments = getLegalDocuments();
  for (const document of legalDocuments) {
    const html = renderLegalDocumentHtml(document.path, baseUrl);
    if (!html) continue;
    const styleSources = getInlineStyleSources(html);
    app.get(document.path, publicRouteRateLimiter, (_req, res) => {
      setPublicPageSecurityHeaders(res, styleSources);
      res.type("html").send(html);
    });
  }

  if (config.publicVideo) {
    const publicVideo = config.publicVideo;
    const videoPagePath = publicVideo.pagePath;
    const videoFileRoute = getPublicVideoFileRoute(videoPagePath);
    const videoPageHtml = renderPublicVideoPageHtml(publicVideo, baseUrl);
    const videoStyleSources = getInlineStyleSources(videoPageHtml);

    app.get(videoPagePath, publicRouteRateLimiter, (_req, res) => {
      setPublicPageSecurityHeaders(res, videoStyleSources, true);
      res.type("html").send(videoPageHtml);
    });

    app.get(videoFileRoute, videoFileRateLimiter, async (req, res) => {
      await streamPublicVideo(req, res, publicVideo.filePath);
    });
  }

  app.get("/healthz", healthRateLimiter, (_req, res) => {
    res.json({ ok: true });
  });

  // Keep JSON-RPC error envelopes scoped to the protocol route. Public pages
  // use a plain-text fallback so an unrelated handler failure cannot return a
  // misleading JSON-RPC response (or Express's default stack-bearing HTML).
  app.use("/mcp", jsonBodyErrorHandler);
  app.use(((error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error(`Public HTTP middleware failed (${formatErrorForLog(error)})`);
    res.status(500).type("text").send("Internal server error.");
  }) satisfies express.ErrorRequestHandler);

  let shutdownHttpServer: (signal?: string) => void = () => undefined;

  function startHttpServer(): Server {
    installTimestampedConsole();
    let sweepInProgress = false;
    const shortestSessionTtlMs = Math.min(
      config.sessionIdleTtlMs,
      config.sessionAbsoluteTtlMs,
      config.unvalidatedSessionTtlMs,
    );
    const sweepTimer = globalThis.setInterval(
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
    );
    sweepTimer.unref();

    const httpServer = app.listen(port, host, () => {
      logInfo(`qURL MCP HTTP server listening on ${sanitizeLogValue(host)}:${port}`);
      logInfo("HTTP MCP auth mode: qURL API-key passthrough");
      if (config.maxUploadFileDataBytes > DEFAULT_MAX_UPLOAD_FILE_DATA_BYTES) {
        console.warn(
          "Warning: maxUploadFileDataBytes exceeds the default; requests above the default parser ceiling require an already-validated MCP session. Apply an authenticated edge request-size limit on hostile networks.",
        );
      }
      if (config.trustProxyHops === 0 && !isLoopbackHostname(host)) {
        console.warn(
          "Warning: non-loopback HTTP listener has trustProxyHops=0, which is valid only for direct connections. Clients behind a reverse proxy will share the proxy's rate-limit bucket; set the exact trusted hop count.",
        );
      }
      logInfo("HTTP and runtime config loaded.");
      logInfo(`Public legal pages enabled: ${legalDocuments.length}`);
      if (config.publicVideo) {
        logInfo("Public video page enabled.");
        void stat(config.publicVideo.filePath)
          .then((stats) => {
            if (!stats.isFile()) {
              console.warn("[public-video] configured path is not a regular file at startup");
            } else if (stats.size === 0) {
              console.warn("[public-video] configured video file is empty at startup");
            }
          })
          .catch(() => {
            console.warn("[public-video] configured video file is unavailable at startup");
          });
      }
      if (defaultQurlConnectorUrl) logInfo("qURL Connector uploads enabled.");
      const smtpInspection = inspectSmtpConfig(runtimeConfigPath);
      logInfo(
        smtpInspection.enabled
          ? "SMTP is configured."
          : `SMTP is not configured. Missing fields: ${smtpInspection.missingFields.join(", ") || "(unknown)"}`,
      );
      for (const warning of smtpInspection.securityWarnings) console.warn(`Warning: ${warning}`);
      if (config.allowedHosts?.length) {
        logInfo(`Host allowlist enabled with ${config.allowedHosts.length} entries.`);
      }
    });

    let shuttingDown = false;
    const removeSignalHandlers = (): void => {
      process.removeListener("SIGTERM", handleSigterm);
      process.removeListener("SIGINT", handleSigint);
    };
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      globalThis.clearInterval(sweepTimer);
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
      globalThis.clearInterval(sweepTimer);
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
    getActiveSessionCount,
    shutdownHttpServer: (signal?: string) => shutdownHttpServer(signal),
    startHttpServer,
    streamPublicVideo,
    sweepExpiredSessions,
  };
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const require = createRequire(import.meta.url);
    const { version } = require("../package.json") as { version: string };
    const runtimeConfigPath = getDefaultConfigPath();
    const config = loadHttpServerConfig(getDefaultHttpConfigPath());
    createHttpRuntime(config, { runtimeConfigPath, version }).startHttpServer();
  } catch (error) {
    installTimestampedConsole();
    console.error(`qURL MCP HTTP startup failed (${formatErrorForLog(error)})`);
    process.exitCode = 1;
  }
}
