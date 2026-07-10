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
