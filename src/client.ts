/**
 * QURL API client for the MCP server.
 */

export interface QURLClientConfig {
  apiKey: string;
  baseURL: string;
}

export interface QURL {
  resource_id: string;
  qurl_link: string;
  qurl_site: string;
  target_url: string;
  description?: string;
  expires_at: string;
  created_at: string;
  status: string;
  access_count: number;
  one_time_use: boolean;
  max_sessions: number;
  metadata?: Record<string, unknown>;
}

export interface CreateQURLInput {
  target_url: string;
  description?: string;
  expires_in?: string;
  one_time_use?: boolean;
  max_sessions?: number;
  metadata?: Record<string, unknown>;
}

export interface ListQURLsInput {
  limit?: number;
  cursor?: string;
}

export interface ListQURLsOutput {
  data: QURL[];
  meta: {
    next_cursor?: string;
    has_more: boolean;
  };
}

export interface ExtendQURLInput {
  extend_by: string;
}

export interface ResolveInput {
  access_token: string;
}

export interface ResolveOutput {
  target_url: string;
  resource_id: string;
  session_id: string;
  access_grant: {
    expires_in: number;
    granted_at: string;
    src_ip: string;
  };
}

export interface QuotaOutput {
  plan: string;
  limits: Record<string, number>;
  usage: Record<string, number>;
}

export interface IQURLClient {
  createQURL(input: CreateQURLInput): Promise<{ data: QURL }>;
  getQURL(id: string): Promise<{ data: QURL }>;
  listQURLs(input?: ListQURLsInput): Promise<ListQURLsOutput>;
  deleteQURL(id: string): Promise<void>;
  extendQURL(id: string, input: ExtendQURLInput): Promise<{ data: QURL }>;
  resolveQURL(input: ResolveInput): Promise<{ data: ResolveOutput }>;
  getQuota(): Promise<{ data: QuotaOutput }>;
}

export class QURLAPIError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "QURLAPIError";
  }
}

export class QURLClient implements IQURLClient {
  private apiKey: string;
  private baseURL: string;

  constructor(config: QURLClientConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();

    // Handle empty 2xx responses (e.g., 204 No Content from DELETE).
    // Only deleteQURL hits this path — T is void there, so undefined is correct.
    if (!text && response.ok) {
      return undefined as T;
    }

    const json = this.parseJSON(text, response.status);

    if (!response.ok) {
      const error = json.error as Record<string, string> | undefined;
      throw new QURLAPIError(
        response.status,
        error?.code ?? "unknown",
        error?.message ?? `HTTP ${response.status}`,
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

  async createQURL(input: CreateQURLInput): Promise<{ data: QURL }> {
    return this.request("POST", "/v1/qurl", input);
  }

  async getQURL(id: string): Promise<{ data: QURL }> {
    return this.request("GET", this.qurlPath(id));
  }

  async listQURLs(input?: ListQURLsInput): Promise<ListQURLsOutput> {
    const params = new URLSearchParams();
    if (input?.limit !== undefined) params.set("limit", String(input.limit));
    if (input?.cursor) params.set("cursor", input.cursor);
    const query = params.toString();
    return this.request("GET", `/v1/qurls${query ? `?${query}` : ""}`);
  }

  async deleteQURL(id: string): Promise<void> {
    await this.request("DELETE", this.qurlPath(id));
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
}
