export const REFERENCE_SITE_URL = "https://layerv.ai";

// Safe for HTML text and quoted attribute values only. Do not reuse this for
// unquoted attributes, URL policy, JavaScript, or CSS contexts.
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Validate an HTTP(S) URL before escaping it for a quoted HTML attribute. */
export function escapeHttpUrlAttribute(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HTML URL attributes must contain an absolute HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("HTML URL attributes must contain an absolute HTTP(S) URL.");
  }
  return escapeHtml(value);
}
