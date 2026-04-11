/**
 * QURL API client for the MCP server.
 */

export interface QURLClientConfig {
  apiKey: string;
  baseURL: string;
}

// --- Response data types ---

export interface AccessToken {
  qurl_id: string;
  label?: string;
  status: string;
  one_time_use: boolean;
  max_sessions: number;
  session_duration: number;
  use_count: number;
  qurl_site?: string;
  access_policy?: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

export interface QURL {
  resource_id: string;
  qurl_site?: string;
  target_url: string;
  description?: string;
  tags?: string[];
  expires_at: string;
  created_at: string;
  status: "active" | "revoked";
  custom_domain?: string | null;
  qurl_count?: number;
  qurls?: AccessToken[];
}

export interface CreateQURLData {
  qurl_id: string;
  resource_id: string;
  qurl_link: string;
  qurl_site: string;
  expires_at: string;
  label?: string;
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
  status?: string;
  created_after?: string;
  created_before?: string;
  expires_before?: string;
  expires_after?: string;
  sort?: string;
  q?: string;
}

export interface UpdateQURLInput {
  extend_by?: string;
  expires_at?: string;
  tags?: string[];
  description?: string;
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
  qurl_link: string;
  expires_at: string;
}

export interface BatchItemResult {
  index: number;
  success: boolean;
  resource_id?: string;
  qurl_link?: string;
  qurl_site?: string;
  expires_at?: string;
  error?: {
    code: string;
    message: string;
  };
}

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

// --- Client interface ---

export interface IQURLClient {
  createQURL(input: CreateQURLInput): Promise<{ data: CreateQURLData }>;
  getQURL(id: string): Promise<{ data: QURL }>;
  listQURLs(input?: ListQURLsInput): Promise<ListQURLsOutput>;
  deleteQURL(id: string): Promise<void>;
  updateQURL(id: string, input: UpdateQURLInput): Promise<{ data: QURL }>;
  extendQURL(id: string, input: ExtendQURLInput): Promise<{ data: QURL }>;
  resolveQURL(input: ResolveInput): Promise<{ data: ResolveOutput }>;
  getQuota(): Promise<{ data: QuotaOutput }>;
  mintLink(id: string, input?: MintLinkInput): Promise<{ data: MintLinkOutput }>;
  batchCreate(input: BatchCreateInput): Promise<BatchCreateOutput>;
}

// --- Error class ---

export class QURLAPIError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public type?: string,
    public instance?: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = "QURLAPIError";
  }
}

// --- Client implementation ---

export class QURLClient implements IQURLClient {
  private apiKey: string;
  private baseURL: string;

  constructor(config: QURLClientConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL.replace(/\/$/, "");
  }

  /**
   * Issue an HTTP request and parse the JSON response.
   *
   * `passthroughStatuses` lets a caller opt certain non-2xx codes out of the
   * default throw-on-error path and receive the parsed body instead. This is
   * used by `batchCreate`, where the API returns a structured BatchCreateResponse
   * on HTTP 400 (all items rejected) — throwing would drop the per-item errors.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    passthroughStatuses: number[] = [],
  ): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();

    // Handle empty 2xx responses (e.g., 204 No Content from DELETE).
    // Only deleteQURL hits this path — T is void there, so undefined is correct.
    if (!text && response.ok) {
      return undefined as T;
    }

    const json = this.parseJSON(text, response.status);

    if (!response.ok && !passthroughStatuses.includes(response.status)) {
      const error = json.error as
        | { type?: string; title?: string; detail?: string; code?: string; message?: string; instance?: string }
        | undefined;
      const meta = json.meta as { request_id?: string } | undefined;
      throw new QURLAPIError(
        response.status,
        error?.code ?? "unknown",
        error?.detail ?? error?.title ?? error?.message ?? `HTTP ${response.status}`,
        error?.type,
        error?.instance,
        meta?.request_id,
      );
    }

    return json as T;
  }

  private parseJSON(text: string, status: number): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new QURLAPIError(
        status,
        "parse_error",
        `Failed to parse response: ${text.slice(0, 200)}`,
      );
    }
  }

  private qurlPath(id: string): string {
    return `/v1/qurls/${encodeURIComponent(id)}`;
  }

  async createQURL(input: CreateQURLInput): Promise<{ data: CreateQURLData }> {
    return this.request("POST", "/v1/qurls", input);
  }

  async getQURL(id: string): Promise<{ data: QURL }> {
    return this.request("GET", this.qurlPath(id));
  }

  async listQURLs(input?: ListQURLsInput): Promise<ListQURLsOutput> {
    const params = new URLSearchParams();
    if (input?.limit !== undefined) params.set("limit", String(input.limit));
    if (input?.cursor) params.set("cursor", input.cursor);
    if (input?.status) params.set("status", input.status);
    if (input?.created_after) params.set("created_after", input.created_after);
    if (input?.created_before) params.set("created_before", input.created_before);
    if (input?.expires_before) params.set("expires_before", input.expires_before);
    if (input?.expires_after) params.set("expires_after", input.expires_after);
    if (input?.sort) params.set("sort", input.sort);
    if (input?.q) params.set("q", input.q);
    const query = params.toString();
    return this.request("GET", `/v1/qurls${query ? `?${query}` : ""}`);
  }

  async deleteQURL(id: string): Promise<void> {
    await this.request("DELETE", this.qurlPath(id));
  }

  async updateQURL(id: string, input: UpdateQURLInput): Promise<{ data: QURL }> {
    return this.request("PATCH", this.qurlPath(id), input);
  }

  async extendQURL(id: string, input: ExtendQURLInput): Promise<{ data: QURL }> {
    return this.request("PATCH", this.qurlPath(id), input);
  }

  async resolveQURL(input: ResolveInput): Promise<{ data: ResolveOutput }> {
    return this.request("POST", "/v1/resolve", input);
  }

  async getQuota(): Promise<{ data: QuotaOutput }> {
    return this.request("GET", "/v1/quota");
  }

  async mintLink(id: string, input?: MintLinkInput): Promise<{ data: MintLinkOutput }> {
    return this.request("POST", `/v1/qurls/${encodeURIComponent(id)}/mint_link`, input);
  }

  async batchCreate(input: BatchCreateInput): Promise<BatchCreateOutput> {
    // 400 carries per-item errors (see request() JSDoc).
    return this.request("POST", "/v1/qurls/batch", input, [400]);
  }
}
