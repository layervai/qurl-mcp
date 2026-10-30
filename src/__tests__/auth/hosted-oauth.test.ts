import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createHostedOAuth,
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  OAUTH_API_AUDIENCE,
  OAUTH_CLIENT_ID,
} from "../../auth/hosted-oauth.js";

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let key: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  key = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" }],
  });
});
afterEach(() => vi.useRealTimers());

async function token(overrides: Record<string, unknown> = {}, downstream = false, kid = "test") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: OAUTH_ISSUER,
    aud: downstream ? OAUTH_API_AUDIENCE : OAUTH_RESOURCE,
    sub: "auth0|customer-a",
    azp: downstream ? OAUTH_CLIENT_ID : "openai-client",
    exp: now + 300,
    scope: "qurl:read",
    "https://layerv.ai/email_verified": true,
    ...(downstream ? { act: { sub: OAUTH_CLIENT_ID }, permissions: ["qurl:admin"] } : {}),
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .sign(privateKey);
}
function response(access_token: string) {
  return Response.json({
    access_token,
    token_type: "Bearer",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
}

describe("hosted OAuth", () => {
  it("distinguishes a signing-key outage from an unrecognized token key", async () => {
    const unavailable = createHostedOAuth("fixture-secret", {
      key: async () => {
        throw new errors.JWKSTimeout();
      },
    });
    await expect(unavailable.verifyAccessToken(await token())).rejects.toMatchObject({
      errorCode: "server_error",
    });
    const unknown = createHostedOAuth("fixture-secret", { key });
    await expect(
      unknown.verifyAccessToken(await token({}, false, "unknown")),
    ).rejects.toMatchObject({ errorCode: "invalid_token" });
  });

  it("does not invalidate a user token when the exchange network fails", async () => {
    const oauth = createHostedOAuth("fixture-secret", {
      key,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed: private diagnostics");
      }),
    });
    await expect(
      oauth.delegate(await oauth.verifyAccessToken(await token())),
    ).rejects.toMatchObject({ errorCode: "server_error" });
  });
  it("validates signed MCP tokens, exchanges once and retains subject and narrow scopes", async () => {
    const input = await token();
    const output = await token({}, true);
    const fetcher = vi.fn(async () => response(output));
    const oauth = createHostedOAuth("fixture-secret", { key, fetch: fetcher });
    const auth = await oauth.verifyAccessToken(input);
    expect(auth.extra?.subject).toBe("auth0|customer-a");
    const results = await Promise.all(Array.from({ length: 12 }, () => oauth.delegate(auth)));
    expect(results.every((value) => value.token === output)).toBe(true);
    expect(results[0].scopes).toEqual(["qurl:read"]);
    await oauth.delegate(await oauth.verifyAccessToken(input));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      URL,
      NonNullable<Parameters<typeof fetch>[1]>,
    ];
    expect(String(url)).toBe(`${OAUTH_ISSUER}oauth/token`);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toMatchObject({
      subject_token: input,
      audience: OAUTH_API_AUDIENCE,
      scope: "qurl:read",
      client_id: OAUTH_CLIENT_ID,
    });
  });

  it("denies wrong issuer/audience, invalid dates, missing claims, binding and empty scope before exchange", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalid = [
      { iss: "https://attacker.example/" },
      { aud: OAUTH_API_AUDIENCE },
      { exp: now - 1 },
      { exp: undefined },
      { nbf: now + 100 },
      { sub: undefined },
      { sub: " " },
      { azp: undefined },
      { scope: undefined },
      { scope: "qurl:admin" },
      { "https://layerv.ai/email_verified": false },
      { "https://layerv.ai/email_verified": undefined },
      { cnf: { jkt: "bound-key" } },
    ];
    const fetcher = vi.fn();
    const oauth = createHostedOAuth("fixture-secret", { key, fetch: fetcher });
    for (const claims of invalid)
      await expect(oauth.verifyAccessToken(await token(claims))).rejects.toThrow(
        "Invalid or expired",
      );
    for (const raw of ["bad", "x".repeat(16_385), (await token()).slice(0, -5) + "aaaaa"]) {
      await expect(oauth.verifyAccessToken(raw)).rejects.toThrow("Invalid or expired");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects wrong delegated identity, missing actor, broad scopes and expired tokens", async () => {
    const invalid = [
      { iss: "https://other.example/" },
      { aud: OAUTH_RESOURCE },
      { sub: "auth0|customer-b" },
      { act: undefined },
      { act: null },
      { act: {} },
      { act: { sub: "other-client" } },
      { azp: "other-client" },
      { scope: "qurl:read qurl:write" },
      { scope: "qurl:read qurl:admin" },
      { scope: "" },
      { exp: 1 },
      { cnf: {} },
    ];
    for (const claims of invalid) {
      const fetcher = vi.fn(async () => response(await token(claims, true)));
      const oauth = createHostedOAuth("fixture-secret", { key, fetch: fetcher });
      const auth = await oauth.verifyAccessToken(await token());
      await expect(oauth.delegate(auth)).rejects.toThrow("Delegated access is unavailable");
    }
  });

  it("never reuses another user's exchange, and retries after provider failure", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("provider secret diagnostic", { status: 403 }))
      .mockResolvedValueOnce(response(await token({}, true)))
      .mockResolvedValueOnce(response(await token({ sub: "auth0|customer-b" }, true)));
    const oauth = createHostedOAuth("fixture-secret", { key, fetch: fetcher });
    const first = await oauth.verifyAccessToken(await token());
    await expect(oauth.delegate(first)).rejects.toThrow("Delegated access is unavailable");
    await oauth.delegate(first);
    const other = await oauth.verifyAccessToken(await token({ sub: "auth0|customer-b" }));
    await oauth.delegate(other);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("refreshes expiring cache entries without extending the incoming token lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Math.floor(Date.now() / 1000);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(await token({ exp: start + 30 }, true)))
      .mockResolvedValueOnce(response(await token({ exp: start + 300 }, true)));
    const oauth = createHostedOAuth("fixture-secret", { key, fetch: fetcher });
    const auth = await oauth.verifyAccessToken(await token({ exp: start + 60 }));
    expect((await oauth.delegate(auth)).expiresAt).toBe(start + 30);
    vi.setSystemTime((start + 27) * 1_000);
    expect((await oauth.delegate(auth)).expiresAt).toBe(start + 60);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed, oversized and non-bearer provider responses without disclosure", async () => {
    const responses = [
      new Response("not json"),
      new Response("x".repeat(33_000)),
      Response.json({ access_token: "secret", token_type: "DPoP" }),
      Response.json({ access_token: "secret", token_type: "Bearer" }),
    ];
    for (const result of responses) {
      const oauth = createHostedOAuth("fixture-secret", { key, fetch: vi.fn(async () => result) });
      await expect(oauth.delegate(await oauth.verifyAccessToken(await token()))).rejects.toThrow(
        "Delegated access is unavailable",
      );
    }
  });
});
