/**
 * qURL API client for the MCP server.
 *
 * The exported `QURLClient` is a thin adapter over the published
 * `@layervai/qurl` SDK: the SDK owns all HTTP, retry, and error-parsing
 * behavior, and this file translates between the SDK's surface and the local
 * domain types/`IQURLClient` contract the tools, resources, and output schemas
 * are written against (`{ data }` wrapping, the `qurls` field name, and the
 * `QURLAPIError` error class).
 */

import { QURLClient as SDKQURLClient, QURLError } from "@layervai/qurl";
import { markRequestCredentialValidated } from "./auth/request-context.js";
import type {
  QURL as SDKQURL,
  Resource as SDKResource,
  UpdateResourceQurlInput as SDKUpdateResourceQurlInput,
} from "@layervai/qurl";

export interface QURLClientConfig {
  apiKey: string;
  baseURL: string;
}

// --- Response data types ---

export interface TombstoneInfo {
  tombstoned_at: string;
  final_access_count?: number;
}

export interface AccessToken {
  qurl_id: string;
  label?: string;
  // Per-token status is a wider enum than resource status, since individual
  // tokens can be consumed (one-time-use) or expire independently of the
  // parent resource. See qurl/api/openapi.yaml -> QurlSummary.status.
  // `"unknown"` is the same drift sentinel as on QURL.status below.
  status: "active" | "consumed" | "expired" | "revoked" | "unknown";
  one_time_use?: boolean;
  max_sessions?: number;
  session_duration?: number;
  use_count?: number;
  qurl_site?: string;
  access_policy?: AccessPolicy;
  created_at?: string;
  expires_at?: string;
}

export interface SessionData {
  session_id: string;
  qurl_id?: string;
  src_ip?: string;
  user_agent?: string;
  created_at?: string;
  last_seen_at?: string;
}

export interface QURL {
  resource_id: string;
  qurl_site?: string;
  // Connector-owned resources intentionally omit target_url from management
  // reads. The field is absent rather than serialized as null.
  target_url?: string;
  description?: string;
  tags?: string[];
  expires_at: string;
  created_at: string;
  // "expired" is documented in api-spec/qurls.yaml's
  // `QurlData.properties.status` description (resources past their
  // expires_at are reported as "expired" without being explicitly
  // revoked) even though the same enum line is narrower. "unknown" is
  // the drift sentinel emitted by qurlSchema.parse via .catch when the
  // API returns a value the spec snapshot doesn't enumerate; see
  // output-schemas.ts for the rationale and the hypothetical-collision
  // note.
  status: "active" | "revoked" | "expired" | "unknown";
  custom_domain?: string | null;
  slug?: string;
  preserve_host?: boolean;
  qurl_count?: number;
  qurls?: AccessToken[];
}

export interface CreateQURLData {
  qurl_id: string;
  resource_id: string;
  qurl_link: string;
  branded_domain?: string;
  qurl_site: string;
  expires_at: string;
  label?: string;
  type?: string;
}

export interface AIAgentPolicy {
  block_all?: boolean;
  deny_categories?: string[];
  allow_categories?: string[];
}

export interface AccessPolicy {
  ip_allowlist?: string[];
  ip_denylist?: string[];
  geo_allowlist?: string[];
  geo_denylist?: string[];
  user_agent_allow_regex?: string;
  user_agent_deny_regex?: string;
  ai_agent_policy?: AIAgentPolicy;
}

// --- Input types ---

export interface CreateQURLInput {
  /** Resource type for integrations that are allowed to mint non-url qURLs. Defaults to "url". */
  type?: string;
  target_url: string;
  label?: string;
  expires_in?: string;
  one_time_use?: boolean;
  max_sessions?: number;
  session_duration?: string;
  custom_domain?: string;
  access_policy?: AccessPolicy;
}

export interface ListQURLsInput {
  limit?: number;
  cursor?: string;
  /** Filter by status. Accepts comma-separated values, e.g. `"active,revoked"`. */
  status?: string;
  /** RFC 3339 timestamp. */
  created_after?: string;
  /** RFC 3339 timestamp. */
  created_before?: string;
  /** RFC 3339 timestamp. */
  expires_before?: string;
  /** RFC 3339 timestamp. */
  expires_after?: string;
  /** Sort field and direction, e.g. `"created_at:desc"`. */
  sort?: string;
  /** Free-text search over description and target_url. */
  q?: string;
}

export interface UpdateQURLInput {
  extend_by?: string;
  expires_at?: string;
  tags?: string[];
  description?: string;
}

export interface UpdateResourceInput {
  tags?: string[];
  description?: string;
  custom_domain?: string;
  preserve_host?: boolean;
}

export interface ExtendQURLInput {
  extend_by: string;
}

export interface ResolveInput {
  access_token: string;
}

export interface MintLinkInput {
  label?: string;
  expires_in?: string;
  expires_at?: string;
  one_time_use?: boolean;
  max_sessions?: number;
  session_duration?: string;
  access_policy?: AccessPolicy;
}

export interface BatchCreateInput {
  items: CreateQURLInput[];
}

export interface UpdateQurlTokenInput {
  extend_by?: string;
  expires_at?: string;
  label?: string;
  access_policy?: AccessPolicy;
  max_sessions?: number;
  session_duration?: string;
}

// --- Output types ---

export interface ListQURLsOutput {
  data: QURL[];
  meta: {
    next_cursor?: string;
    has_more: boolean;
    page_size?: number;
    request_id?: string;
  };
}

export interface ResolveOutput {
  target_url: string;
  resource_id: string;
  access_grant: {
    expires_in: number;
    granted_at: string;
    src_ip: string;
  };
}

export interface QuotaOutput {
  plan: "free" | "growth" | "enterprise";
  period_start: string;
  period_end: string;
  rate_limits: {
    create_per_minute: number;
    create_per_hour: number;
    list_per_minute: number;
    resolve_per_minute: number;
    max_active_qurls: number;
    max_tokens_per_qurl: number;
    max_expiry_seconds: number;
  };
  usage: {
    qurls_created: number;
    active_qurls: number;
    active_qurls_percent: number | null;
    total_accesses: number;
  };
}

export interface MintLinkOutput {
  qurl_id: string;
  qurl_link: string;
  branded_domain?: string;
  expires_at: string;
  type?: string;
}

// Discriminated on `success` so consumers narrowing on the boolean get
// type-safe access to the success-only fields (qurl_link, etc.) and the
// failure-only `error` shape. The API contract is mutually exclusive at
// the per-item level — a result either succeeded or carries an error,
// never both.
export type BatchItemResult =
  | {
      index: number;
      success: true;
      resource_id: string;
      qurl_link: string;
      branded_domain?: string;
      qurl_site: string;
      expires_at: string;
    }
  | {
      index: number;
      success: false;
      error: {
        code: string;
        message: string;
      };
    };

export interface BatchCreateOutput {
  data: {
    succeeded: number;
    failed: number;
    results: BatchItemResult[];
  };
  meta: {
    request_id?: string;
  };
}

export interface SessionListOutput {
  data: SessionData[];
  meta?: {
    request_id?: string;
  };
}

export interface SessionTerminateOutput {
  data: {
    terminated: number;
  };
  meta?: {
    request_id?: string;
  };
}

// --- Client interface ---

export interface IQURLClient {
  /**
   * Create a new qURL. Returns `CreateQURLData` — the ephemeral create-time
   * shape that carries `qurl_link` (shown only once) and `qurl_id`. This is
   * intentionally distinct from the `QURL` shape returned by `getQURL` /
   * `listQURLs`, which does not include `qurl_link`.
   */
  createQURL(input: CreateQURLInput): Promise<{ data: CreateQURLData }>;
  /**
   * Fetch a resource and its access tokens. Returns the stable `QURL` shape
   * (no `qurl_link` — that only exists on the create response).
   */
  getQURL(id: string): Promise<{ data: QURL }>;
  listQURLs(input?: ListQURLsInput): Promise<ListQURLsOutput>;
  deleteQURL(id: string): Promise<void>;
  updateQURL(id: string, input: UpdateQURLInput): Promise<{ data: QURL }>;
  updateResource(id: string, input: UpdateResourceInput): Promise<{ data: QURL }>;
  extendQURL(id: string, input: ExtendQURLInput): Promise<{ data: QURL }>;
  resolveQURL(input: ResolveInput): Promise<{ data: ResolveOutput }>;
  getQuota(): Promise<{ data: QuotaOutput }>;
  mintLink(id: string, input?: MintLinkInput): Promise<{ data: MintLinkOutput }>;
  batchCreate(input: BatchCreateInput): Promise<BatchCreateOutput>;
  revokeQurlToken(resourceId: string, qurlId: string): Promise<void>;
  updateQurlToken(
    resourceId: string,
    qurlId: string,
    input: UpdateQurlTokenInput,
  ): Promise<{ data: AccessToken }>;
  listResourceSessions(resourceId: string): Promise<SessionListOutput>;
  terminateResourceSession(resourceId: string, sessionId: string): Promise<void>;
  terminateAllResourceSessions(resourceId: string): Promise<SessionTerminateOutput>;
}

// --- Error class ---

/**
 * Error thrown by `QURLClient` for any API or pre-flight failure.
 *
 * `statusCode` is the HTTP response status, with one sentinel: **`0`** means
 * the error was raised on the client before any network request was issued
 * (e.g. `code: "missing_api_key"`). Branching logic that inspects HTTP
 * status should special-case `0` rather than treating it as a real status.
 */
export class QURLAPIError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public type?: string,
    public instance?: string,
    public requestId?: string,
    public tombstone?: TombstoneInfo,
  ) {
    super(message);
    this.name = "QURLAPIError";
  }
}

/**
 * Shared message for the missing-API-key condition. Emitted both at boot
 * (stderr warning in `index.ts`) and on every API call (the lazy `sdk` getter
 * throws it when no key is configured).
 * Keeping a single string means a user grepping logs/transcripts hits the
 * same phrase from both sites, and the CI introspection probe has a stable
 * substring to assert against.
 */
export const MISSING_API_KEY_MESSAGE =
  "QURL_API_KEY is not set. Set it in the MCP server environment or runtime config and restart to make API calls.";

// --- SDK adapter helpers ---

/**
 * Translate an error thrown by the SDK into the `QURLAPIError` the MCP tools
 * branch on. Two consumers depend on the exact fields: `delete-qurl` checks
 * `statusCode === 404`, and `withMissingApiKeyHandler` checks
 * `code === "missing_api_key"`. A `QURLAPIError` we raised ourselves (the
 * missing-key pre-flight) passes through untouched; anything that isn't a
 * `QURLError` is returned as-is.
 */
function translateError(err: unknown): unknown {
  if (err instanceof QURLAPIError) return err;
  if (err instanceof QURLError) {
    return new QURLAPIError(
      err.status,
      err.code,
      // `QURLError.detail` is non-optional and always populated (the SDK falls
      // back to `title` when the API omits detail), so it carries the same
      // human-readable text the old client's detail/title/message chain did.
      err.detail,
      err.type,
      err.instance,
      err.requestId,
      // 410 tombstone metadata: the SDK's QURLError does not currently surface
      // it, so this is always undefined. Kept for forward-compat and because
      // QURLAPIError carries the field; no MCP tool reads it today.
      (err as { tombstone?: TombstoneInfo }).tombstone,
    );
  }
  return err;
}

/**
 * Map an SDK resource read (`QURL`/`Resource`) onto the MCP's `QURL` shape.
 * The only structural difference is the field name for the nested tokens:
 * the SDK exposes `access_tokens`, the MCP's output schemas validate `qurls`.
 * When the SDK omits `access_tokens`, the key is dropped entirely rather than
 * surfaced as `qurls: undefined`.
 */
function mapResource(raw: SDKQURL | SDKResource): QURL {
  const { access_tokens, ...rest } = raw as SDKQURL;
  // Drop the key for both `undefined` and a defensive `null`.
  const mapped =
    access_tokens === undefined || access_tokens === null
      ? rest
      : { ...rest, qurls: access_tokens };
  return mapped as unknown as QURL;
}

// --- Client implementation ---

/**
 * Adapter implementing {@link IQURLClient} over the `@layervai/qurl` SDK.
 *
 * The SDK owns HTTP, retries, and error parsing. This class only translates
 * shapes (re-wraps the SDK's unwrapped returns into `{ data }`, renames
 * `access_tokens` → `qurls`, reshapes list/batch/session envelopes) and maps
 * the SDK's `QURLError` subclasses onto `QURLAPIError`.
 */
export class QURLClient implements IQURLClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  /**
   * Constructed lazily on first API call. The SDK constructor throws on an
   * empty key, but `index.ts` deliberately boots the server keyless so MCP
   * introspection (tools/list, resources/list, prompts/list) works without a
   * configured key — the missing-key error must defer to the first real call.
   */
  private _sdk?: SDKQURLClient;

  constructor(config: QURLClientConfig) {
    // `?? ""` defends against JS callers that hand in `undefined` (the TS
    // type forbids it, but `JSON.parse`'d configs and other dynamic call
    // sites can land here). Trim so a whitespace-only key (e.g. from a
    // stray `QURL_API_KEY=" "`) takes the typed `missing_api_key` path
    // instead of being sent over the wire as a server-side 401.
    this.apiKey = (config.apiKey ?? "").trim();
    // `?? ""` mirrors the apiKey guard above: a JS caller passing `undefined`
    // for baseURL (the TS type forbids it; index.ts always supplies a default)
    // gets the default-empty path rather than a raw TypeError from `.replace`.
    this.baseURL = (config.baseURL ?? "").replace(/\/$/, "");
  }

  /**
   * Lazily build the SDK client. Throws the typed `missing_api_key` error
   * (status 0) when no key is configured, matching the pre-SDK behavior that
   * `withMissingApiKeyHandler` and the CI introspection probe rely on. Note
   * the SDK option is `baseUrl` (lowercase) vs. the MCP config's `baseURL`.
   */
  private get sdk(): SDKQURLClient {
    if (!this.apiKey) {
      throw new QURLAPIError(0, "missing_api_key", MISSING_API_KEY_MESSAGE);
    }
    if (!this._sdk) {
      this._sdk = new SDKQURLClient({ apiKey: this.apiKey, baseUrl: this.baseURL });
    }
    return this._sdk;
  }

  /** Run an SDK call, translating its errors into `QURLAPIError`. */
  private async call<T>(fn: (sdk: SDKQURLClient) => Promise<T>): Promise<T> {
    try {
      const result = await fn(this.sdk);
      // Only a successful API response conclusively validates the request
      // credential. Any error status may have originated from an intermediary
      // before the qURL API authenticated the bearer token. This trust boundary
      // assumes the operator-configured HTTPS endpoint and its intermediaries
      // neither synthesize nor cache authenticated success responses.
      markRequestCredentialValidated();
      return result;
    } catch (err) {
      throw translateError(err);
    }
  }

  // Casts at the SDK boundary are kept as tight as the compiler allows:
  // inputs pass through unannotated where the MCP type is structurally
  // assignable to the SDK type (a genuine drift then fails to compile), and
  // outputs use a single `as` (not `as unknown as`) so a grossly incompatible
  // SDK return is still rejected. `mapResource`'s `QURL`/`Resource` → MCP
  // `QURL` conversion is the one place a double cast is genuinely required.
  // The tools additionally validate every `structuredContent` against their
  // zod `outputSchema`, so any residual response drift surfaces at runtime.

  async createQURL(input: CreateQURLInput): Promise<{ data: CreateQURLData }> {
    return this.call(async (sdk) => ({ data: (await sdk.create(input)) as CreateQURLData }));
  }

  async getQURL(id: string): Promise<{ data: QURL }> {
    return this.call(async (sdk) => ({ data: mapResource(await sdk.get(id)) }));
  }

  async listQURLs(input?: ListQURLsInput): Promise<ListQURLsOutput> {
    return this.call(async (sdk) => {
      const out = await sdk.list(input);
      // The SDK's list envelope is `{ qurls, next_cursor, has_more }` and does
      // not surface `meta.page_size` / `meta.request_id` (both optional in the
      // output schema), so they are intentionally absent here.
      return {
        data: out.qurls.map(mapResource),
        meta: { next_cursor: out.next_cursor, has_more: out.has_more },
      };
    });
  }

  async deleteQURL(id: string): Promise<void> {
    await this.call((sdk) => sdk.delete(id));
  }

  async updateQURL(id: string, input: UpdateQURLInput): Promise<{ data: QURL }> {
    return this.call(async (sdk) => ({ data: mapResource(await sdk.update(id, input)) }));
  }

  async updateResource(id: string, input: UpdateResourceInput): Promise<{ data: QURL }> {
    return this.call(async (sdk) => ({ data: mapResource(await sdk.updateResource(id, input)) }));
  }

  async extendQURL(id: string, input: ExtendQURLInput): Promise<{ data: QURL }> {
    return this.call(async (sdk) => ({ data: mapResource(await sdk.extend(id, input)) }));
  }

  async resolveQURL(input: ResolveInput): Promise<{ data: ResolveOutput }> {
    return this.call(async (sdk) => ({ data: (await sdk.resolve(input)) as ResolveOutput }));
  }

  async getQuota(): Promise<{ data: QuotaOutput }> {
    return this.call(async (sdk) => ({ data: (await sdk.getQuota()) as QuotaOutput }));
  }

  async mintLink(id: string, input?: MintLinkInput): Promise<{ data: MintLinkOutput }> {
    return this.call(async (sdk) => ({ data: (await sdk.mintLink(id, input)) as MintLinkOutput }));
  }

  async batchCreate(input: BatchCreateInput): Promise<BatchCreateOutput> {
    return this.call(async (sdk) => {
      // The SDK passes through HTTP 400 (all items failed) as a populated
      // BatchCreateOutput rather than throwing, so the all-failed case still
      // reaches here with `failed > 0` — matching the old passthrough behavior
      // that batch-create.ts depends on. A populated response proves the API
      // accepted the credential, so the shared call wrapper intentionally
      // marks the request credential validated even for this HTTP 400 shape.
      const out = await sdk.batchCreate(input);
      return {
        data: {
          succeeded: out.succeeded,
          failed: out.failed,
          results: out.results as BatchItemResult[],
        },
        meta: { request_id: out.request_id },
      };
    });
  }

  async revokeQurlToken(resourceId: string, qurlId: string): Promise<void> {
    await this.call((sdk) => sdk.revokeResourceQurl(resourceId, qurlId));
  }

  async updateQurlToken(
    resourceId: string,
    qurlId: string,
    input: UpdateQurlTokenInput,
  ): Promise<{ data: AccessToken }> {
    return this.call(async (sdk) => ({
      // The SDK types this input as an extend_by-XOR-expires_at discriminated
      // union; the MCP's UpdateQurlTokenInput allows both fields and enforces
      // the XOR via a zod refinement in update-qurl-token.ts, so bridge here.
      data: (await sdk.updateResourceQurl(
        resourceId,
        qurlId,
        input as unknown as SDKUpdateResourceQurlInput,
      )) as AccessToken,
    }));
  }

  async listResourceSessions(resourceId: string): Promise<SessionListOutput> {
    return this.call(async (sdk) => {
      const out = await sdk.listResourceSessions(resourceId);
      return {
        data: out.sessions as SessionData[],
        meta: { request_id: out.request_id },
      };
    });
  }

  async terminateResourceSession(resourceId: string, sessionId: string): Promise<void> {
    await this.call((sdk) => sdk.terminateResourceSession(resourceId, sessionId));
  }

  async terminateAllResourceSessions(resourceId: string): Promise<SessionTerminateOutput> {
    return this.call(async (sdk) => {
      const out = await sdk.terminateAllResourceSessions(resourceId);
      return {
        data: { terminated: out.terminated },
        meta: { request_id: out.request_id },
      };
    });
  }
}
