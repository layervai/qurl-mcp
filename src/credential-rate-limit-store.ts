export interface CredentialRateLimitIncrement {
  credentialDigest: string;
  windowStartedAtMs: number;
}

export interface CredentialRateLimitStore {
  initialize(): Promise<void>;
  increment(input: CredentialRateLimitIncrement): Promise<number>;
}

export interface DynamoDbOperations {
  describeTable(tableName: string): Promise<unknown>;
  updateItem(input: DynamoDbUpdateItemInput): Promise<unknown>;
}

type DynamoDbAttributeValue = { N: string } | { S: string };

export interface DynamoDbUpdateItemInput {
  TableName: string;
  Key: Record<string, DynamoDbAttributeValue>;
  UpdateExpression: string;
  ExpressionAttributeValues: Record<string, DynamoDbAttributeValue>;
  ReturnValues: "UPDATED_NEW";
}

interface DynamoDbSdk {
  DynamoDBClient: new () => { send(command: unknown): Promise<unknown> };
  DescribeTableCommand: new (input: { TableName: string }) => unknown;
  UpdateItemCommand: new (input: DynamoDbUpdateItemInput) => unknown;
}

const WINDOW_MS = 60_000;
const TTL_GRACE_SECONDS = 60 * 60;

function minuteBucket(windowStartedAtMs: number): number {
  return Math.floor(windowStartedAtMs / WINDOW_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tableStatusFrom(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.Table)) return undefined;
  return typeof result.Table.TableStatus === "string" ? result.Table.TableStatus : undefined;
}

type CounterResult = { ok: true; count: number } | { ok: false };

function counterFrom(result: unknown): CounterResult {
  if (!isRecord(result) || !isRecord(result.Attributes)) return { ok: false };
  const requestCount = result.Attributes.request_count;
  if (!isRecord(requestCount) || typeof requestCount.N !== "string") return { ok: false };

  const count = Number(requestCount.N);
  return Number.isSafeInteger(count) && count >= 1 ? { ok: true, count } : { ok: false };
}

async function createDefaultDynamoDbOperations(): Promise<DynamoDbOperations> {
  // Keep the AWS SDK out of stdio and memory-store installs/startup. Deployed
  // HTTP images include optional dependencies; omitting it still fails closed
  // during initialization, before the listener can accept traffic.
  let sdk: DynamoDbSdk;
  try {
    // Keep this specifier indirect so a source checkout can compile after
    // `npm install --omit=optional`; the runtime import still fails closed if
    // an HTTP deployment selects DynamoDB without packaging the SDK.
    const sdkModule = "@aws-sdk/client-dynamodb";
    sdk = (await import(sdkModule)) as unknown as DynamoDbSdk;
  } catch (error) {
    throw new Error("The dynamodb credential rate-limit store requires @aws-sdk/client-dynamodb.", {
      cause: error,
    });
  }
  const { DescribeTableCommand, DynamoDBClient, UpdateItemCommand } = sdk;
  const client = new DynamoDBClient();
  return {
    describeTable: (tableName) => client.send(new DescribeTableCommand({ TableName: tableName })),
    updateItem: (input) => client.send(new UpdateItemCommand(input)),
  };
}

export function credentialRateLimitKey(input: CredentialRateLimitIncrement): string {
  return `v1#${input.credentialDigest}#${minuteBucket(input.windowStartedAtMs)}`;
}

export class MemoryCredentialRateLimitStore implements CredentialRateLimitStore {
  readonly #counts = new Map<string, number>();
  #minuteBucket: number | undefined;

  async initialize(): Promise<void> {}

  async increment(input: CredentialRateLimitIncrement): Promise<number> {
    const currentMinuteBucket = minuteBucket(input.windowStartedAtMs);
    if (currentMinuteBucket !== this.#minuteBucket) {
      // The key already isolates windows; clearing is eviction so old bearer
      // digests do not accumulate in a long-lived process.
      this.#counts.clear();
      this.#minuteBucket = currentMinuteBucket;
    }
    const key = credentialRateLimitKey(input);
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return count;
  }
}

export class DynamoDbCredentialRateLimitStore implements CredentialRateLimitStore {
  #operations?: Promise<DynamoDbOperations>;
  readonly #tableName: string;

  constructor(tableName: string, operations?: DynamoDbOperations) {
    this.#tableName = tableName;
    this.#operations = operations ? Promise.resolve(operations) : undefined;
  }

  #getOperations(): Promise<DynamoDbOperations> {
    // Start the optional SDK import only when initialization or use is awaited,
    // so merely constructing an unused embedder store cannot create an
    // unhandled rejected import promise.
    this.#operations ??= createDefaultDynamoDbOperations();
    return this.#operations;
  }

  async initialize(): Promise<void> {
    const operations = await this.#getOperations();
    const result = await operations.describeTable(this.#tableName);
    if (tableStatusFrom(result) !== "ACTIVE") {
      throw new Error("DynamoDB credential rate-limit table is not active.");
    }
  }

  async increment(input: CredentialRateLimitIncrement): Promise<number> {
    const bucketStartedAtSeconds = minuteBucket(input.windowStartedAtMs) * 60;
    const expiresAt = bucketStartedAtSeconds + 60 + TTL_GRACE_SECONDS;
    const operations = await this.#getOperations();
    const result = await operations.updateItem({
      TableName: this.#tableName,
      Key: { rate_key: { S: credentialRateLimitKey(input) } },
      UpdateExpression:
        "SET expires_at = if_not_exists(expires_at, :expires_at) ADD request_count :one",
      ExpressionAttributeValues: {
        ":one": { N: "1" },
        ":expires_at": { N: String(expiresAt) },
      },
      ReturnValues: "UPDATED_NEW",
    });
    const counter = counterFrom(result);
    if (!counter.ok) {
      throw new Error("DynamoDB credential rate-limit counter returned an invalid value.");
    }
    return counter.count;
  }
}
