# Hosted OAuth integration

This opt-in operator integration lets a user connect their LayerV account
through Auth0. It is source preparation for directory review, not an activated
service or a published plugin.

## Runtime contract

API-key passthrough remains the default. `MCP_HOSTED_OAUTH=true` (or
`hostedOAuth: true` in the HTTP configuration) adds OAuth to the existing
stateless `/mcp` endpoint. qURL `lv_live_*` and `lv_test_*` API keys keep
their existing tool catalog and downstream validation. OAuth failures never
fall back to API-key passthrough.

Set `MCP_OAUTH_SIGN_IN_CLIENT_ID` to the approved user sign-in client ID.
Use separate sign-in clients for Sandbox and production. Supply
`MCP_OAUTH_CLIENT_SECRET` through secret injection. It is the server's
exchange client secret, not the sign-in client secret or a qURL account key.
These values come from the environment, not the HTTP JSON file.

Both environments use issuer `https://auth.layerv.ai/`. The MCP audience
is the environment's public URL ending in `/mcp`. Sandbox exchanges only
for `https://api.layerv.xyz` and requires a separate exchange client ID in
`MCP_OAUTH_SANDBOX_EXCHANGE_CLIENT_ID`. Production exchanges only for
`https://api.layerv.ai` using the existing exchange client
`qH003Rwgjj1wvRXs2iFHthczmJs0fGjr`. The server publishes discovery at
`/.well-known/oauth-protected-resource/mcp` and its root alias.

Every OAuth POST validates the incoming RS256 signature, issuer, MCP audience,
expiry/not-before, subject, client, verified-email claim and allowed scopes.
Sender-constrained tokens are denied: this bearer integration does not implement
DPoP or mTLS proof validation. Auth0 exchanges a valid token for the API audience.
Before forwarding, the server validates the returned signature, issuer, audience,
expiry, same user subject, expected `azp` and outer `act.sub`, and scopes no
broader than the incoming approved scope set. RBAC/custom permissions never
expand the MCP scope set.

Only the exchanged token goes to the API and connector. IP and credential rate
limits still apply to the incoming token. Concurrency admission precedes JWT
work; a client disconnect does not release a permit while verification or
exchange is pending. Exchanges have a five-second deadline, bounded response
bytes, a 1,000-entry in-memory cache and per-token single-flight. Cache lifetime
never exceeds either token. Tokens and secrets are not written to disk or
returned to clients. Caches are process-local; no global request lock or exchange
on each tool call is added. Fleet/provider rate limits still need qualification.

OAuth exposes `list_crid_access` for invitation and grant listings (`qurl:read`),
and `manage_crid_access` only for changes (`qurl:write`). Read and write actions
are rejected by the other tool before any API call. Existing API-key HTTP and
local catalogs keep their combined access tool unchanged. This catalog split
adds no downstream operations or round trips. OAuth marks every non-read-only
tool as destructive so directory clients request confirmation for data changes;
read-only and legacy-client annotations remain unchanged. This follows the
[Anthropic connector checklist](https://claude.com/docs/connectors/building/review-criteria),
which requires the destructive hint for tools that modify data, including additions.

Each tool checks its required scope before its handler. The installed SDK exposes
OAuth tool descriptors through the documented `_meta.securitySchemes` compatibility
field. Insufficient scope returns `mcp/www_authenticate` for reauthorization.
Resources require read scope. OAuth mode does not authorize operator SMTP.

Access tokens retain their issued authority until expiry; disconnecting or
blocking sign-in does not itself revoke issued JWTs. The approved provider
maximum is one hour. Validate and disclose this window during review; do not
claim immediate account-token revocation.

## RELEASE activation gates

Keep Auth0 OBO and the runtime option OFF until these gates pass:

1. Deploy qurl-service#1978 before accepting delegated API tokens. Deploy and
   read back website#1208's bound Auth0 Action separately; website deployment
   does not deploy that Action. Preserve the login flow and global API policy.
2. Register dedicated Sandbox and production sign-in clients with exact
   callbacks and the matching MCP API audience. Configure Auth0 to enforce
   authorization code with S256 PKCE for each sign-in client. Confirm that
   missing PKCE and wrong verifiers fail. Verify resource handling and consent
   with the real provider. Grant each exchange client only its environment's
   API audience and approved scopes. Add the Sandbox exchange client ID and
   audience pair to the Auth0 Action before enabling exchange.
3. Qualify real read-only and read/write exchanges, issued actor/scope and
   unchanged owner. Deny admin/enrollment, wrong audience, missing actor,
   unverified user and cross-user access. A verified customer with no assigned
   role must complete intended read/write operations. Do not force-add scopes
   or bypass consent/RBAC to hide a missing entitlement.
4. Verify connector JWT authentication before accepting/storing upload bytes,
   upload ownership, denial behavior, cleanup and expiry. Local inspection shows
   caller-bearer forwarding; it does not establish the deployed contract.
5. Use the existing candidate-isolated deployment lane and RELEASE's shared
   gates. Validate rate limits, cache behavior and provider exchange capacity.
   This source is not million-user capacity certification.
   First qualify the Sandbox client and audiences with owned test identities.
   Use the same image digest for production after Sandbox passes. Verify the
   old API-key catalog and an authenticated API-key tool call before and after.
6. Complete five positive/three negative vendor workflows, scoped reviewer
   account, domain verification, cleanup and demo. Verify portal acceptance of
   tool metadata. Get action-time legal confirmation before final submission.

Rollback: turn OBO and hosted OAuth access off before reverting the Action or
API scope boundary. The same endpoint continues serving API-key clients.
Do not let issued delegated tokens regain account-permission fallback.

References: [OpenAI auth](https://developers.openai.com/plugins/build/auth),
[Auth0 OBO](https://auth0.com/docs/secure/call-apis-on-users-behalf/on-behalf-of-token-exchange),
[tool metadata](https://developers.openai.com/plugins/reference#tool-descriptor-parameters).

## Google Connected Apps

The preview application and MCP registration are separate. After preview access,
create the Connected App and use the MCP HTTPS URL ending in `/mcp`. In Google
Connected Console, download the domain challenge for the MCP host. Set
`MCP_GOOGLE_CONNECTED_APPS_VERIFICATION_TOKEN` to the token from that file.
Confirm that `GET /.well-known/google-connected-apps` on that host returns the
matching JSON directly, without authentication or a redirect. The route is off
when the variable is absent. This public token is not an OAuth credential.
Domain verification can run before OAuth activation.

In Access credentials, select user-delegated authorization with a pre-registered
client. Use a separate Auth0 sign-in client for Google and allow only the exact
app-specific redirect URIs from the console. Do not give Google the server's
token exchange client or its secret. Use authorization code with PKCE S256.
Confirm Auth0 maps the resource indicator to the MCP audience; do not change the
tenant's default audience to make the test pass.

Apply the release gates above to this client. Check both protected-resource
metadata URLs, the 401 discovery challenge, and live Auth0 discovery. In Gemini
Developer Mode, prove sign-in, tool sync and a tool call with a verified test
user. Check that a second user cannot access the first user's resources and that
read-only consent cannot authorize a write. Confirm that refresh maintains the
same user, audience and scope limits if it is enabled. Use only seeded test
data for Google review.

References: [Google OAuth guide](https://developers.google.com/connected-apps/mcp/oauth)
and [Connected Console setup](https://developers.google.com/connected-apps/gpc/perform-the-steps).
