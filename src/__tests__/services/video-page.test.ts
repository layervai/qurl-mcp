import { describe, expect, it } from "vitest";
import { getPublicVideoFileRoute, renderPublicVideoPageHtml } from "../../services/video-page.js";

describe("video page", () => {
  it("derives the public file route from the page path", () => {
    expect(getPublicVideoFileRoute("/media/video")).toBe("/media/video/file");
    expect(getPublicVideoFileRoute("/custom/video")).toBe("/custom/video/file");
  });

  it("renders a public video playback page", () => {
    const html = renderPublicVideoPageHtml(
      {
        title: "Launch Demo",
        pagePath: "/media/video",
        filePath: "D:/videos/demo.mp4",
      },
      "https://qurl.example.com",
    );

    expect(html).toContain("<title>Launch Demo | LayerV</title>");
    expect(html).toContain('rel="canonical" href="https://qurl.example.com/media/video"');
    expect(html).toContain('src="https://qurl.example.com/media/video/file"');
    expect(html).toContain("demo.mp4");
    expect(html).toContain("Public Video Playback");
  });

  it("escapes adversarial operator-provided title and filename values", () => {
    const html = renderPublicVideoPageHtml(
      {
        title: '"><script>alert("title")</script>',
        pagePath: "/media/video",
        filePath: '/srv/media/"><img src=x onerror=alert(1)>.mp4',
      },
      "https://qurl.example.com",
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.mp4");
  });
});
