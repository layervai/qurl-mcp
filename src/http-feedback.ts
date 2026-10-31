import { FEEDBACK_HTTP_PATH } from "./http-routes.js";
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
    standardHeaders: "draft-8",
    legacyHeaders: false,
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
        typeof error === "object" && error !== null && "status" in error && error.status === 413
          ? 413
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
      res.status(400).json({ error: "Submit feedback one report at a time." });
      return;
    }
    void feedbackRateLimiter(req, res, next);
  };
}
