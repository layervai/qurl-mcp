import type { Buffer } from "node:buffer";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { createServer } from "./server.js";
import type { HttpServerConfig } from "./http-config.js";
import { clearSensitiveLogValues, formatErrorForLog } from "./logging.js";

export type SessionContext = {
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

export type StatelessRequestContext = {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
  bearerToken: string;
  closePromise?: Promise<void>;
};

type WithRequestAuth = <T>(
  sessionId: string | undefined,
  bearerToken: string,
  fn: () => Promise<T>,
) => Promise<T>;

export interface HttpSessionRegistry {
  closingSessions: Map<string, Promise<void>>;
  sessions: Map<string, SessionContext>;
  activeStatelessRequests: Set<StatelessRequestContext>;
  closingStatelessRequests: Set<Promise<void>>;
  markSessionDisconnected(sessionId: string | undefined): void;
  closeSession(sessionId: string): Promise<void>;
  sweepExpiredSessions(now?: number): Promise<number>;
  closeAllSessions(): Promise<void>;
  closeStatelessRequest(request: StatelessRequestContext): Promise<void>;
  trackSessionActivity<T>(session: SessionContext, fn: () => Promise<T>): Promise<T>;
  getActiveSessionCount(): number;
}

const DISCONNECTED_SESSION_GRACE_MS = 30_000;

export function createHttpSessionRegistry(
  config: HttpServerConfig,
  withRequestAuth: WithRequestAuth,
): HttpSessionRegistry {
  const sessions = new Map<string, SessionContext>();
  const closingSessions = new Map<string, Promise<void>>();
  const activeStatelessRequests = new Set<StatelessRequestContext>();
  const closingStatelessRequests = new Set<Promise<void>>();

  function markSessionDisconnected(sessionId: string | undefined): void {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const disconnectedAt = Date.now();
    session.lastActivityAt = disconnectedAt;
    session.disconnectedAt = disconnectedAt;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const existingClose = closingSessions.get(sessionId);
    if (existingClose) {
      await existingClose;
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) return;
    // Admission replacement relies on removal before the first await.
    sessions.delete(sessionId);
    const closePromise = withRequestAuth(
      session.sessionId,
      session.bearerTokenForRedaction,
      async () => {
        try {
          await session.server.close();
        } catch (error) {
          // Format while the credential-scoped redaction context is still active.
          console.error(`[mcp-http] session close failed (${formatErrorForLog(error)})`);
        }
      },
    );
    closingSessions.set(sessionId, closePromise);
    try {
      await closePromise;
    } finally {
      closingSessions.delete(sessionId);
      clearSensitiveLogValues(`http-session:${sessionId}`);
    }
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
    // A concurrent DELETE/sweep may have removed its registry entry while its
    // asynchronous server.close() is still settling. Shutdown callers wait for
    // that ownership cleanup too rather than observing an empty registry early.
    await Promise.all([...closingSessions.values()]);
    await Promise.all(
      [...activeStatelessRequests].map((request) => closeStatelessRequest(request)),
    );
    await Promise.all([...closingStatelessRequests]);
  }

  async function closeStatelessRequest(request: StatelessRequestContext): Promise<void> {
    if (request.closePromise) {
      await request.closePromise;
      return;
    }
    activeStatelessRequests.delete(request);
    const bearerToken = request.bearerToken;
    const closePromise = withRequestAuth(undefined, bearerToken, async () => {
      try {
        await request.transport.close();
      } catch (error) {
        console.error(`[mcp-http] stateless transport close failed (${formatErrorForLog(error)})`);
      }
      try {
        await request.server.close();
      } catch (error) {
        console.error(`[mcp-http] stateless server close failed (${formatErrorForLog(error)})`);
      }
    }).finally(() => {
      request.bearerToken = "";
      closingStatelessRequests.delete(closePromise);
    });
    request.closePromise = closePromise;
    closingStatelessRequests.add(closePromise);
    await closePromise;
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

  return {
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
  };
}
