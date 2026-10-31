import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type express from "express";
import { rateLimit } from "express-rate-limit";
import type { HttpServerConfig } from "./http-config.js";
import { formatErrorForLog, logInfo } from "./logging.js";
import { getLegalDocuments, renderLegalDocumentHtml } from "./services/legal-pages.js";
import { getPublicVideoFileRoute, renderPublicVideoPageHtml } from "./services/video-page.js";

interface PublicHttpOptions {
  fileStreamFactory?: (
    filePath: string,
    options: { start?: number; end?: number },
  ) => ReturnType<typeof createReadStream>;
}

export interface PublicHttpRoutes {
  publicRouteRateLimiter: express.RequestHandler;
  register(app: express.Express): void;
  logStartupStatus(): void;
  streamPublicVideo(req: express.Request, res: express.Response, filePath: string): Promise<void>;
}

export function createPublicRateLimiter(config: HttpServerConfig) {
  return rateLimit({
    windowMs: 60_000,
    limit: config.publicFileRateLimitPerMinute,
    ipv6Subnet: 56,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).send("Too many requests.");
    },
  });
}

export function createPublicHttpRoutes(
  config: HttpServerConfig,
  options: PublicHttpOptions,
): PublicHttpRoutes {
  const baseUrl = config.baseUrl;
  // Page traffic, byte ranges, and the runtime's health limiter use separate buckets.
  const publicRouteRateLimiter = createPublicRateLimiter(config);
  const videoFileRateLimiter = createPublicRateLimiter(config);
  let legalDocuments: ReturnType<typeof getLegalDocuments> = [];
  async function streamPublicVideo(
    req: express.Request,
    res: express.Response,
    filePath: string,
  ): Promise<void> {
    setPublicPageSecurityHeaders(res);
    let stats;
    try {
      // Refuse a final-component symlink so a public video path cannot be
      // retargeted to a different local file after operator configuration.
      // Intermediate directory symlinks retain normal resolution because this
      // absolute path is trusted operator config, never request-derived input.
      stats = await lstat(filePath);
    } catch (error) {
      console.error(`[public-video] file inspection failed (${formatErrorForLog(error)})`);
      res.status(404).send("Configured video file was not found.");
      return;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
      res.status(404).send("Configured video file was not found.");
      return;
    }

    // Content-Length is a request-time snapshot. Public media is trusted,
    // operator-owned configuration and should be replaced atomically; if it
    // is truncated in place, the stream error path below destroys the response
    // rather than serving a silently successful partial body.
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

  function register(app: express.Express): void {
    legalDocuments = config.serveLayerVLegalPages ? getLegalDocuments() : [];
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
  }
  function logStartupStatus(): void {
    logInfo(`Public legal pages enabled: ${legalDocuments.length}`);
    if (config.publicVideo) {
      logInfo("Public video page enabled.");
      // The video is an optional public asset, not an MCP readiness
      // dependency. Warn at boot but keep /healthz and MCP available; the
      // request path independently fails closed until the asset is usable.
      void lstat(config.publicVideo.filePath)
        .then((stats) => {
          if (stats.isSymbolicLink() || !stats.isFile()) {
            console.warn("[public-video] configured path is not a regular file at startup");
          } else if (stats.size === 0) {
            console.warn("[public-video] configured video file is empty at startup");
          }
        })
        .catch(() => {
          console.warn("[public-video] configured video file is unavailable at startup");
        });
    }
  }
  return { register, logStartupStatus, streamPublicVideo, publicRouteRateLimiter };
}
