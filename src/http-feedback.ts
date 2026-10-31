import { FEEDBACK_HTTP_PATH, MCP_HTTP_PATH } from "./http-routes.js";
import express from "express";
import { rateLimit } from "express-rate-limit";
import {
  deliverFeedback,
  FeedbackError,
  feedbackSchema,
  feedbackWebhookUrl,
} from "./services/feedback.js";

export function registerFeedbackRoute(
  app: express.Express,
  allowedOrigin: string,
): express.RequestHandler {
  feedbackWebhookUrl(); // Fail startup on malformed operator config without printing the secret.
  const feedbackRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1_000,
    limit: 5,
    ipv6Subnet: 56,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => {
      res.set("Cache-Control", "no-store");
      const message = "Feedback was not sent: too many reports. Try again later.";
      if (req.path === MCP_HTTP_PATH || req.path === `${MCP_HTTP_PATH}/`) {
        res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } });
      } else res.status(429).json({ error: message });
    },
  });
  app.post(
    FEEDBACK_HTTP_PATH,
    feedbackRateLimiter,
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.set("Cache-Control", "no-store");
      if (req.headers.origin !== undefined && req.headers.origin !== allowedOrigin) {
        res.status(403).json({ error: "Origin is not allowed." });
      } else if (!req.is("application/json")) {
        res.status(415).json({ error: "Use application/json." });
      } else next();
    },
    express.json({ limit: "4kb", inflate: false }),
    async (req: express.Request, res: express.Response) => {
      const parsed = feedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid feedback report." });
        return;
      }
      try {
        res.status(200).json(await deliverFeedback(parsed.data));
      } catch (error) {
        const status = error instanceof FeedbackError ? error.status : 503;
        if (status === 429) res.set("Retry-After", "1");
        res.status(status).json({
          error: error instanceof FeedbackError ? error.message : "Feedback is unavailable.",
        });
      }
    },
    ((error, _req, res, _next) => {
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number" &&
        error.status >= 400 &&
        error.status < 500
          ? error.status
          : 400;
      res.status(status).json({ error: "Invalid feedback JSON body." });
    }) as express.ErrorRequestHandler,
  );
  return (req, res, next) => {
    const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    const hasFeedback = messages.some((message) => {
      if (!message || typeof message !== "object") return false;
      const call = message as { method?: unknown; params?: { name?: unknown } };
      return call.method === "tools/call" && call.params?.name === "submit_feedback";
    });
    if (!hasFeedback) {
      next();
      return;
    }
    if (Array.isArray(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Submit feedback one report at a time." },
      });
      return;
    }
    void feedbackRateLimiter(req, res, next);
  };
}
