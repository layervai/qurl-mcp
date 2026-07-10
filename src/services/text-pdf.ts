import PDFDocument from "pdfkit";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isControlCodePoint } from "../text.js";

const bundledFontPath = fileURLToPath(
  new URL("../../assets/fonts/NotoSansSC-VF.ttf", import.meta.url),
);
export const MAX_TEXT_PDF_CONTENT_CHARACTERS = 100_000;

function sanitizePdfText(input: string, fallback: string): string {
  let sanitized = "";
  let replacingControlCharacters = false;
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControlCharacter = isControlCodePoint(codePoint);
    if (isControlCharacter) {
      if (!replacingControlCharacters) sanitized += " ";
    } else {
      sanitized += character;
    }
    replacingControlCharacters = isControlCharacter;
  }
  return sanitized.trim() || fallback;
}

function ensurePdfFileName(input: string | undefined): string {
  const baseName = basename(sanitizePdfText(input ?? "content", "content")) || "content";
  const sourceExtension = extname(baseName);
  const withoutExt = baseName.toLowerCase().endsWith(".pdf")
    ? baseName.slice(0, -4)
    : sourceExtension
      ? baseName.slice(0, -sourceExtension.length)
      : baseName;
  const normalizedStem = withoutExt.replace(/\.+$/, "");
  const safeStem = normalizedStem || "content";
  return `${safeStem}.pdf`;
}

export function resolveFontPath(candidatePath = bundledFontPath): string | undefined {
  if (existsSync(candidatePath)) return candidatePath;
  console.warn(
    "[text-pdf] bundled Noto Sans SC font is missing; falling back to Helvetica with limited CJK coverage",
  );
  return undefined;
}

let cachedBundledFontPath: string | undefined;
let hasResolvedBundledFontPath = false;

function getBundledFontPath(): string | undefined {
  if (!hasResolvedBundledFontPath) {
    // Resolve lazily so a missing-asset warning passes through the installed
    // console timestamp/redaction boundary instead of running during ESM
    // evaluation. Published assets are immutable, so cache the decision.
    cachedBundledFontPath = resolveFontPath();
    hasResolvedBundledFontPath = true;
  }
  return cachedBundledFontPath;
}

export async function createTextPdfTempFile(input: {
  content: string;
  fileName?: string;
  title?: string;
}): Promise<{
  cleanup: () => Promise<void>;
  fileName: string;
  filePath: string;
  sizeBytes: number;
}> {
  // Deliberately match Zod's UTF-16-unit maxLength behavior in the public tool
  // schema. The HTTP parser and connector byte caps provide the memory bound.
  if (input.content.length > MAX_TEXT_PDF_CONTENT_CHARACTERS) {
    throw new Error(
      `PDF content must not exceed ${MAX_TEXT_PDF_CONTENT_CHARACTERS.toLocaleString("en-US")} characters.`,
    );
  }
  const tempDir = await mkdtemp(join(tmpdir(), "qurl-text-pdf-"));
  const fileName = ensurePdfFileName(input.fileName);
  const filePath = join(tempDir, fileName);
  const fontPath = getBundledFontPath();

  try {
    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({
        autoFirstPage: true,
        margin: 56,
        size: "A4",
      });
      const stream = createWriteStream(filePath);
      let settled = false;

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        stream.removeAllListeners("finish");
        if (stream.closed) {
          doc.removeAllListeners();
          if (!doc.destroyed) doc.destroy();
          reject(error);
          return;
        }
        stream.once("close", () => reject(error));
        if (!stream.destroyed) stream.destroy();
        doc.removeAllListeners();
        if (!doc.destroyed) doc.destroy();
      };

      stream.once("finish", succeed);
      stream.once("error", fail);
      doc.once("error", fail);

      try {
        doc.pipe(stream);
        doc.info.Title = sanitizePdfText(input.title ?? fileName, fileName);
        if (fontPath) {
          doc.font(fontPath);
        }
        doc.fontSize(12);
        doc.text(input.content, {
          align: "left",
          lineGap: 4,
        });
        doc.end();
      } catch (error) {
        fail(error);
      }
    });

    const fileStat = await stat(filePath);

    return {
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
      fileName,
      filePath,
      sizeBytes: fileStat.size,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
