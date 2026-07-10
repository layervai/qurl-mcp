import { basename } from "node:path";
import type { PublicVideoConfig } from "../config.js";
import { escapeHtml, REFERENCE_SITE_URL } from "./html.js";

export function getPublicVideoFileRoute(pagePath: string): string {
  // pagePath has already passed normalizePublicPath at configuration load.
  return `${pagePath}/file`;
}

export function renderPublicVideoPageHtml(config: PublicVideoConfig, baseUrl: string): string {
  const canonicalUrl = new URL(config.pagePath, baseUrl).toString();
  const videoUrl = new URL(getPublicVideoFileRoute(config.pagePath), baseUrl).toString();
  const fileName = basename(config.filePath);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(config.title)} | LayerV</title>
    <meta name="description" content="${escapeHtml(config.title)} video playback page served by qURL." />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0d09;
        --panel: rgba(20, 24, 18, 0.88);
        --panel-strong: rgba(14, 18, 12, 0.96);
        --border: rgba(194, 255, 66, 0.14);
        --text: #f5f7f1;
        --muted: #b8c0b2;
        --accent: #b9ff2c;
        --accent-soft: rgba(185, 255, 44, 0.12);
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--text);
        background:
          linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px),
          radial-gradient(circle at top left, rgba(185,255,44,0.12), transparent 24%),
          linear-gradient(180deg, #0d100c 0%, #070906 100%);
        background-size: 48px 48px, 48px 48px, auto, auto;
      }

      a {
        color: var(--accent);
        text-decoration: none;
      }

      a:hover {
        text-decoration: underline;
      }

      .shell {
        width: min(1180px, calc(100% - 32px));
        margin: 0 auto;
      }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 22px 0 18px;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        color: var(--text);
        font-size: 0.96rem;
        letter-spacing: 0.04em;
      }

      .brand-mark {
        width: 40px;
        height: 2px;
        border-radius: 999px;
        background: linear-gradient(90deg, transparent, var(--accent));
        box-shadow: 0 0 18px rgba(185, 255, 44, 0.5);
      }

      .home-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        padding: 0 18px;
        border-radius: 14px;
        background: var(--accent);
        color: #11140d;
        font-weight: 700;
        box-shadow: 0 14px 40px rgba(185, 255, 44, 0.24);
      }

      .hero {
        padding: 36px 0 24px;
      }

      .eyebrow {
        margin: 0 0 16px;
        color: var(--accent);
        font-size: 0.92rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(280px, 0.9fr);
        gap: 28px;
        align-items: start;
      }

      .hero h1 {
        margin: 0;
        font-size: clamp(2.8rem, 6vw, 5.25rem);
        line-height: 0.95;
        font-weight: 300;
        letter-spacing: -0.04em;
        max-width: 10ch;
      }

      .hero-copy {
        margin-top: 20px;
        max-width: 680px;
        color: var(--muted);
        font-size: 1.08rem;
        line-height: 1.8;
      }

      .summary-card {
        padding: 22px 22px 20px;
        border: 1px solid var(--border);
        border-radius: 24px;
        background: var(--panel);
        box-shadow: var(--shadow);
      }

      .summary-card h2 {
        margin: 0 0 14px;
        font-size: 1rem;
        color: var(--accent);
      }

      .summary-card p {
        margin: 0;
        color: var(--muted);
        line-height: 1.75;
      }

      .video-card {
        margin: 22px 0 72px;
        padding: 28px;
        border-radius: 28px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, var(--panel) 0%, var(--panel-strong) 100%);
        box-shadow: var(--shadow);
      }

      .video-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 22px;
        padding-bottom: 16px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
      }

      .dot.red { background: #ff5f57; }
      .dot.yellow { background: #febc2e; }
      .dot.green { background: #28c840; }

      .doc-label {
        margin-left: 8px;
        color: var(--muted);
        font-size: 0.92rem;
        letter-spacing: 0.08em;
        text-transform: lowercase;
      }

      .video-frame {
        overflow: hidden;
        border-radius: 24px;
        border: 1px solid rgba(255,255,255,0.08);
        background:
          radial-gradient(circle at top, rgba(185,255,44,0.08), transparent 38%),
          #040604;
      }

      .video-frame video {
        display: block;
        width: 100%;
        max-height: 78vh;
        background: #020302;
      }

      .video-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-top: 16px;
        color: var(--muted);
        font-size: 0.96rem;
      }

      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 0 0 36px;
        color: var(--muted);
        font-size: 0.95rem;
      }

      @media (max-width: 860px) {
        .shell {
          width: min(100% - 24px, 100%);
        }

        .topbar,
        .footer,
        .hero-grid,
        .video-meta {
          grid-template-columns: 1fr;
          flex-direction: column;
          align-items: flex-start;
        }

        .video-card {
          padding: 20px;
          border-radius: 22px;
        }

        .home-link {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="${escapeHtml(REFERENCE_SITE_URL)}" aria-label="LayerV Home">
          <span class="brand-mark" aria-hidden="true"></span>
          <span>LayerV Media</span>
        </a>
        <a class="home-link" href="${escapeHtml(REFERENCE_SITE_URL)}">Back to layerv.ai</a>
      </header>

      <section class="hero">
        <p class="eyebrow">Public Video Playback</p>
        <div class="hero-grid">
          <div>
            <h1>${escapeHtml(config.title)}</h1>
            <p class="hero-copy">
              This public video page is served by the qURL service and provides a clean browser playback experience for the configured MP4 asset.
            </p>
          </div>
          <aside class="summary-card">
            <h2>Playback Ready</h2>
            <p>
              The page streams the configured video file directly from the qURL HTTP service and supports native browser controls.
            </p>
          </aside>
        </div>
      </section>

      <section class="video-card">
        <div class="video-toolbar" aria-hidden="true">
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
          <span class="doc-label">${escapeHtml(fileName)}</span>
        </div>
        <div class="video-frame">
          <video controls playsinline preload="metadata">
            <source src="${escapeHtml(videoUrl)}" type="video/mp4" />
            Your browser does not support the MP4 video element.
          </video>
        </div>
        <div class="video-meta">
          <span>Route: ${escapeHtml(config.pagePath)}</span>
          <a href="${escapeHtml(videoUrl)}">Open raw video stream</a>
        </div>
      </section>

      <footer class="footer">
        <span>LayerV public media page</span>
        <a href="${escapeHtml(REFERENCE_SITE_URL)}">${escapeHtml(REFERENCE_SITE_URL)}</a>
      </footer>
    </div>
  </body>
</html>`;
}
