export interface McpMetricsIdentity {
  namespace: string;
  service: string;
  environment: string;
}

export interface McpMetricsSnapshot {
  McpConcurrencyUtilization: number;
  McpConcurrencyRejected: number;
  McpRateLimitStoreErrors: number;
}

export function normalizeMcpMetricsIdentity(
  input: { namespace?: unknown; service?: unknown; environment?: unknown },
  stateless: boolean,
): McpMetricsIdentity | undefined {
  const values = [input.namespace, input.service, input.environment];
  const configuredFields = values.filter((value) => value !== undefined).length;
  if (configuredFields === 0) return undefined;
  if (!stateless) {
    throw new Error("MCP metrics identity is supported only in stateless HTTP mode.");
  }
  if (configuredFields < 3) {
    throw new Error("MCP metrics namespace, service, and environment must be configured together.");
  }
  const normalizeField = (value: unknown): string => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("MCP metrics namespace, service, and environment must be non-empty strings.");
    }
    return value.trim();
  };
  // configuredFields === 3 above guarantees all three values are present;
  // normalizeField performs the remaining type, whitespace, and content checks.
  const namespace = normalizeField(input.namespace);
  const service = normalizeField(input.service);
  const environment = normalizeField(input.environment);
  return { namespace, service, environment };
}

export class McpEmfMetrics {
  #concurrencyRejected = 0;
  #peakConcurrencyUtilization = 0;
  #rateLimitStoreErrors = 0;
  readonly #identity?: McpMetricsIdentity;
  readonly #getConcurrencyUtilization: () => number;

  constructor(identity: McpMetricsIdentity | undefined, getConcurrencyUtilization: () => number) {
    this.#identity = identity;
    this.#getConcurrencyUtilization = getConcurrencyUtilization;
  }

  incrementConcurrencyRejected(): void {
    this.#concurrencyRejected += 1;
  }

  observeConcurrencyUtilization(): void {
    this.#peakConcurrencyUtilization = Math.max(
      this.#peakConcurrencyUtilization,
      this.#getConcurrencyUtilization(),
    );
  }

  incrementRateLimitStoreErrors(): void {
    this.#rateLimitStoreErrors += 1;
  }

  snapshotAndReset(): McpMetricsSnapshot {
    const snapshot = {
      McpConcurrencyUtilization: Math.max(
        this.#peakConcurrencyUtilization,
        this.#getConcurrencyUtilization(),
      ),
      McpConcurrencyRejected: this.#concurrencyRejected,
      McpRateLimitStoreErrors: this.#rateLimitStoreErrors,
    };
    this.#concurrencyRejected = 0;
    this.#peakConcurrencyUtilization = 0;
    this.#rateLimitStoreErrors = 0;
    return snapshot;
  }

  emitHeartbeat(timestamp = Date.now()): McpMetricsSnapshot | undefined {
    // Counters are interval deltas, so every heartbeat boundary consumes the
    // interval even when no identity is configured. This keeps a later emitter
    // from reporting stale events from an earlier, non-emitting interval.
    const snapshot = this.snapshotAndReset();
    if (!this.#identity) return undefined;
    // Bypass installTimestampedConsole: EMF must be one raw JSON object on
    // stdout. A timestamp prefix, stderr routing, or log sanitization prevents
    // CloudWatch from extracting the metric envelope.
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: timestamp,
          CloudWatchMetrics: [
            {
              Namespace: this.#identity.namespace,
              Dimensions: [["Service", "Environment"]],
              Metrics: [
                { Name: "McpConcurrencyUtilization", Unit: "Percent" },
                { Name: "McpConcurrencyRejected", Unit: "Count" },
                { Name: "McpRateLimitStoreErrors", Unit: "Count" },
              ],
            },
          ],
        },
        Service: this.#identity.service,
        Environment: this.#identity.environment,
        ...snapshot,
      })}\n`,
    );
    return snapshot;
  }
}
