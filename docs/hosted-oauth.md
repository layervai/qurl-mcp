# Hosted OAuth integration

This opt-in operator integration lets a user connect their LayerV account
through Auth0. It is source preparation for directory review, not an activated
service or a published plugin.

## Runtime contract

API-key passthrough remains the default. `MCP_HOSTED_OAUTH=true` (or
`hostedOAuth: true` in the HTTP configuration) selects OAuth-only HTTP.
It requires stateless mode, the production API URL and the canonical MCP URL.
Keep existing API-key consumers on their compatibility deployment; enabling
OAuth changes the authentication contract on that listener.

Supply `MCP_OAUTH_CLIENT_SECRET` through the normal secret-injection path.
The HTTP JSON file cannot supply it. This is the dedicated Auth0 Custom API
client's secret, never a qURL account key. This change creates no provider
application, secret, SSM parameter or infrastructure configuration.

The server uses issuer `https://auth.layerv.ai/`, MCP audience
`https://mcp.connector.layerv.ai/mcp`, and dedicated client
`qH003Rwgjj1wvRXs2iFHthczmJs0fGjr`. It publishes protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp` and the root alias. Missing or
invalid bearer tokens receive a metadata challenge.

Every POST validates the incoming RS256 signature, issuer, MCP audience,
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
read-only and legacy-client annotations remain unchanged.

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
2. Register the OpenAI OAuth client using the existing draft's exact callback
   and supported registration method. Verify authorization-code S256, resource
   handling, discovery and consent with the actual provider.
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
   The isolated candidate retains the production resource identifier; it does
   not take production traffic. Use controlled direct ingress and owned fixture
   identities against the production API, under RELEASE authorization. A separate
   staging issuer/audience needs separately approved provider registration.
6. Complete five positive/three negative vendor workflows, scoped reviewer
   account, domain verification, cleanup and demo. Verify portal acceptance of
   tool metadata. Get action-time legal confirmation before final submission.

Rollback: turn OBO and hosted OAuth access off before reverting the Action or
API scope boundary. Preserve the API-key deployment for compatibility consumers.
Do not let issued delegated tokens regain account-permission fallback.

References: [OpenAI auth](https://developers.openai.com/plugins/build/auth),
[Auth0 OBO](https://auth0.com/docs/secure/call-apis-on-users-behalf/on-behalf-of-token-exchange),
[tool metadata](https://developers.openai.com/plugins/reference#tool-descriptor-parameters).
