import PDFDocument from "pdfkit";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTextPdfTempFile, resolveFontPath } from "../../services/text-pdf.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTextPdfTempFile", () => {
  it("creates a pdf, normalizes the file name, and cleans it up", async () => {
    const result = await createTextPdfTempFile({
      content: "窗前明月光",
      fileName: "note.txt",
      title: "Test PDF",
    });

    expect(result.fileName).toBe("note.pdf");
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(result.filePath)).toBe(true);

    await result.cleanup();
    expect(existsSync(result.filePath)).toBe(false);
  });

  it.each([".pdf", "..pdf"])("normalizes empty-stem PDF filename %s", async (fileName) => {
    const result = await createTextPdfTempFile({ content: "safe", fileName });

    expect(result.fileName).toBe("content.pdf");
    await result.cleanup();
  });

  it("normalizes chained source extensions to one PDF extension", async () => {
    const result = await createTextPdfTempFile({ content: "safe", fileName: "archive.tar.gz" });

    expect(result.fileName).toBe("archive.pdf");
    await result.cleanup();
  });

  it("enforces the renderer content bound at the service boundary", async () => {
    await expect(createTextPdfTempFile({ content: "x".repeat(100_001) })).rejects.toThrow(
      "must not exceed 100,000 characters",
    );
  });

  it("removes control characters from filenames and PDF title metadata", async () => {
    const end = vi.spyOn(PDFDocument.prototype, "end");
    const result = await createTextPdfTempFile({
      content: "safe content",
      fileName: "report\u0000\n.pdf",
      title: "Quarterly\u0000\nReport",
    });

    expect(result.fileName).toBe("report .pdf");
    expect(end.mock.instances[0].info.Title).toBe("Quarterly Report");
    await result.cleanup();
  });

  it("ships with a bundled font asset for cross-platform rendering", () => {
    const bundledFont = resolve(process.cwd(), "assets", "fonts", "NotoSansSC-VF.ttf");
    expect(existsSync(bundledFont)).toBe(true);
  });

  it("warns when the bundled font is unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(resolveFontPath(join(tmpdir(), "missing-qurl-font.ttf"))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("limited CJK coverage"));
  });

  it("destroys the write stream and removes the temp directory after a render error", async () => {
    const tempEntriesBefore = new Set(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith("qurl-text-pdf-")),
    );
    const destroy = vi.spyOn(Writable.prototype, "destroy");
    vi.spyOn(PDFDocument.prototype, "text").mockImplementation(() => {
      throw new Error("text render failed");
    });

    await expect(createTextPdfTempFile({ content: "hello" })).rejects.toThrow("text render failed");

    expect(destroy).toHaveBeenCalled();
    const newTempEntries = readdirSync(tmpdir()).filter(
      (entry) => entry.startsWith("qurl-text-pdf-") && !tempEntriesBefore.has(entry),
    );
    expect(newTempEntries).toEqual([]);
  });
});
