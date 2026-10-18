import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function waitForNpmRelease(
  name,
  version,
  {
    request = fetch,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 12,
  } = {},
) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await request(url, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const metadata = await response.json();
      if (metadata.name !== name || metadata.version !== version) {
        throw new Error("npm returned a different package or version");
      }
      console.log(`npm release is available: ${name}@${version}`);
      return;
    }
    if (response.status !== 404) {
      throw new Error(`npm readiness request failed: HTTP ${response.status}`);
    }
    if (attempt < attempts) await pause(10_000);
  }
  throw new Error(`npm release did not become available: ${name}@${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = JSON.parse(readFileSync("server.json", "utf8"));
  const npmPackages = server.packages.filter((pkg) => pkg.registryType === "npm");
  if (npmPackages.length !== 1) throw new Error("Expected exactly one npm package in server.json");
  const { identifier, version } = npmPackages[0];
  if (typeof identifier !== "string" || !identifier || typeof version !== "string" || !version) {
    throw new Error("Missing npm package name or version in server.json");
  }
  await waitForNpmRelease(identifier, version);
}
