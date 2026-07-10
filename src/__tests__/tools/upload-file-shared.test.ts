import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  getConnectorUploadUrl,
  normalizeFileName,
  validateFileSignature,
  validateFileNameContentType,
} from "../../tools/upload-file-shared.js";

describe("getConnectorUploadUrl", () => {
  it("builds the fixed connector upload endpoint for HTTPS origins", () => {
    expect(getConnectorUploadUrl("https://connector.example.com")).toBe(
      "https://connector.example.com/api/upload",
    );
    expect(getConnectorUploadUrl("https://connector.example.com/api/upload")).toBe(
      "https://connector.example.com/api/upload",
    );
  });

  it("allows HTTP only for loopback development endpoints", () => {
    expect(getConnectorUploadUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/api/upload");
    expect(getConnectorUploadUrl("http://127.42.0.7:8080")).toBe(
      "http://127.42.0.7:8080/api/upload",
    );
    expect(getConnectorUploadUrl("http://127.255.255.255:8080")).toBe(
      "http://127.255.255.255:8080/api/upload",
    );
    expect(getConnectorUploadUrl("http://2130706433:8080")).toBe(
      "http://127.0.0.1:8080/api/upload",
    );
    expect(getConnectorUploadUrl("http://[0:0:0:0:0:0:0:1]:8080")).toBe(
      "http://[::1]:8080/api/upload",
    );
    expect(getConnectorUploadUrl("http://[::ffff:127.0.0.1]:8080")).toBe(
      "http://[::ffff:7f00:1]:8080/api/upload",
    );
    expect(() => getConnectorUploadUrl("http://connector.example.com")).toThrow("must use HTTPS");
    expect(() => getConnectorUploadUrl("http://192.0.2.1:8080")).toThrow("must use HTTPS");
    expect(() => getConnectorUploadUrl("http://[2001:db8::1]:8080")).toThrow("must use HTTPS");
  });

  it("allows operator-configured HTTPS connectors on private networks", () => {
    // Connector URLs are trusted deployment configuration, not request input;
    // private HTTPS endpoints are valid for internal connector deployments.
    expect(getConnectorUploadUrl("https://169.254.169.254")).toBe(
      "https://169.254.169.254/api/upload",
    );
    expect(getConnectorUploadUrl("https://10.0.0.1/qurl")).toBe("https://10.0.0.1/qurl/api/upload");
  });

  it("rejects connector URLs with embedded credentials", () => {
    expect(() => getConnectorUploadUrl("https://user:pass@connector.example.com")).toThrow(
      "must not contain embedded credentials",
    );
  });

  it("preserves a safe base path and rejects ambiguous URL suffixes", () => {
    expect(getConnectorUploadUrl("https://connector.example.com/qurl")).toBe(
      "https://connector.example.com/qurl/api/upload",
    );
    expect(() => getConnectorUploadUrl("https://connector.example.com?target=other")).toThrow(
      "must not contain a query string",
    );
    expect(() => getConnectorUploadUrl("https://connector.example.com/#other")).toThrow(
      "must not contain a fragment",
    );
    expect(() => getConnectorUploadUrl("https://connector.example.com/tenant/../admin")).toThrow(
      "must not contain dot path segments",
    );
    expect(() =>
      getConnectorUploadUrl("https://connector.example.com/tenant/%2e%2e/admin"),
    ).toThrow("must not contain dot path segments");
  });
});

describe("file name validation", () => {
  it("strips traversal components and rejects control characters", () => {
    expect(normalizeFileName("../../private/sample.pdf")).toBe("sample.pdf");
    expect(normalizeFileName("..\\..\\private\\sample.pdf")).toBe("sample.pdf");
    expect(() => normalizeFileName("sample\u0000.pdf")).toThrow("control characters");
  });

  it("rejects misleading or unsupported extensions", () => {
    expect(() => validateFileNameContentType("image.png.exe", "image/png")).toThrow(
      "supported PDF or raster image extension",
    );
    expect(() => validateFileNameContentType("document.pdf", "image/png")).toThrow(
      "does not match",
    );
    expect(() => validateFileNameContentType("document", "application/pdf")).toThrow(
      "supported PDF or raster image extension",
    );
  });

  it("requires the PDF signature at the start of the file", () => {
    expect(() =>
      validateFileSignature(Buffer.from("junk before %PDF-1.7"), "application/pdf"),
    ).toThrow("does not match");
    expect(() => validateFileSignature(Buffer.from("%PDF-1.7"), "application/pdf")).not.toThrow();
    expect(() =>
      validateFileSignature(Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]), "application/pdf"),
    ).toThrow("does not match");
  });

  it("requires a valid WebP image chunk after the RIFF/WEBP header", () => {
    const valid = Buffer.alloc(16);
    valid.write("RIFF", 0, "ascii");
    valid.writeUInt32LE(valid.length - 8, 4);
    valid.write("WEBP", 8, "ascii");
    valid.write("VP8X", 12, "ascii");
    const invalid = Buffer.from(valid);
    invalid.write("WAVE", 12, "ascii");
    const trailingPolyglot = Buffer.concat([valid, Buffer.from("trailing")]);

    expect(() => validateFileSignature(valid, "image/webp")).not.toThrow();
    expect(() => validateFileSignature(invalid, "image/webp")).toThrow("does not match");
    expect(() => validateFileSignature(trailingPolyglot, "image/webp")).toThrow("does not match");
  });

  it("requires JPEG files to end at an image end marker", () => {
    const valid = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
    const trailingPolyglot = Buffer.concat([valid, Buffer.from("trailing")]);

    expect(() => validateFileSignature(valid, "image/jpeg")).not.toThrow();
    expect(() => validateFileSignature(trailingPolyglot, "image/jpeg")).toThrow("does not match");
  });
});
