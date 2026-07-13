import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  DynamoDbCredentialRateLimitStore,
  MemoryCredentialRateLimitStore,
  credentialRateLimitKey,
  type DynamoDbUpdateItemInput,
} from "../credential-rate-limit-store.js";

interface InstalledDynamoDbSdk {
  DynamoDBClient: new (config: unknown) => {
    config: {
      requestHandler: {
        constructor: { name: string };
        httpHandlerConfigs?: () => Record<string, unknown>;
      };
    };
    destroy(): void;
    send(command: unknown): Promise<unknown>;
  };
  DescribeTableCommand: new (input: { TableName: string }) => unknown;
}

describe("credential rate-limit stores", () => {
  afterEach(() => {
    vi.doUnmock("@aws-sdk/client-dynamodb");
  });
  it("uses credential digest plus UTC minute and resets at the boundary", async () => {
    const store = new MemoryCredentialRateLimitStore();
    const firstMinute = Date.UTC(2026, 6, 13, 12, 0, 59, 999);
    const nextMinute = firstMinute + 1;

    expect(
      credentialRateLimitKey({ credentialDigest: "abc", windowStartedAtMs: firstMinute }),
    ).not.toBe(credentialRateLimitKey({ credentialDigest: "abc", windowStartedAtMs: nextMinute }));
    expect(await store.increment({ credentialDigest: "abc", windowStartedAtMs: firstMinute })).toBe(
      1,
    );
    expect(await store.increment({ credentialDigest: "abc", windowStartedAtMs: firstMinute })).toBe(
      2,
    );
    expect(await store.increment({ credentialDigest: "abc", windowStartedAtMs: nextMinute })).toBe(
      1,
    );
  });

  it("does not combine distinct credential digests", async () => {
    const store = new MemoryCredentialRateLimitStore();
    const now = Date.now();
    expect(await store.increment({ credentialDigest: "one", windowStartedAtMs: now })).toBe(1);
    expect(await store.increment({ credentialDigest: "two", windowStartedAtMs: now })).toBe(1);
  });

  it("describes the table before serving and atomically returns the DynamoDB count", async () => {
    const describeTable = vi.fn(async (_tableName: string) => ({
      Table: { TableName: "rate-table", TableStatus: "ACTIVE" },
    }));
    const updateItem = vi.fn(async (_input: DynamoDbUpdateItemInput) => ({
      Attributes: { request_count: { N: "7" } },
    }));
    const store = new DynamoDbCredentialRateLimitStore("rate-table", {
      describeTable,
      updateItem,
    });
    await store.initialize();
    expect(await store.increment({ credentialDigest: "digest-only", windowStartedAtMs: 0 })).toBe(
      7,
    );

    expect(describeTable).toHaveBeenCalledWith("rate-table");
    expect(updateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: "rate-table",
        Key: { rate_key: { S: "v1#digest-only#0" } },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const update = updateItem.mock.calls[0]?.[0];
    expect(update?.ExpressionAttributeValues?.[":expires_at"]).toEqual({ N: "3660" });
  });

  it("fails closed on an invalid DynamoDB counter response", async () => {
    const store = new DynamoDbCredentialRateLimitStore("rate-table", {
      describeTable: vi.fn(async () => ({ Table: { TableStatus: "ACTIVE" } })),
      updateItem: vi.fn(async () => ({ Attributes: {} })),
    });
    await expect(
      store.increment({ credentialDigest: "digest-only", windowStartedAtMs: Date.now() }),
    ).rejects.toThrow("invalid value");
  });

  it("fails closed when the DynamoDB table is not active", async () => {
    const store = new DynamoDbCredentialRateLimitStore("rate-table", {
      describeTable: vi.fn(async () => ({ Table: { TableStatus: "CREATING" } })),
      updateItem: vi.fn(),
    });
    await expect(store.initialize()).rejects.toThrow("not active");
  });

  it("fails closed when the optional DynamoDB SDK is unavailable", async () => {
    vi.doMock("@aws-sdk/client-dynamodb", () => {
      throw new Error("simulated missing optional dependency");
    });
    const store = new DynamoDbCredentialRateLimitStore("rate-table");
    await expect(store.initialize()).rejects.toThrow("requires @aws-sdk/client-dynamodb");
  });

  it("bounds default DynamoDB retries and network timeouts", async () => {
    let clientConfig: unknown;
    class DescribeTableCommand {
      readonly input: { TableName: string };

      constructor(input: { TableName: string }) {
        this.input = input;
      }
    }
    class UpdateItemCommand {
      constructor(_input: DynamoDbUpdateItemInput) {}
    }
    class DynamoDBClient {
      constructor(config: unknown) {
        clientConfig = config;
      }

      async send(command: unknown): Promise<unknown> {
        if (command instanceof DescribeTableCommand) {
          return { Table: { TableName: command.input.TableName, TableStatus: "ACTIVE" } };
        }
        return { Attributes: { request_count: { N: "1" } } };
      }
    }
    vi.doMock("@aws-sdk/client-dynamodb", () => ({
      DescribeTableCommand,
      DynamoDBClient,
      UpdateItemCommand,
    }));

    const store = new DynamoDbCredentialRateLimitStore("rate-table");
    await store.initialize();

    expect(clientConfig).toEqual({
      maxAttempts: 2,
      retryMode: "standard",
      requestHandler: {
        connectionTimeout: 1_000,
        requestTimeout: 2_000,
        throwOnRequestTimeout: true,
      },
    });
  });

  it("fails closed when the optional SDK has an incompatible runtime surface", async () => {
    vi.doMock("@aws-sdk/client-dynamodb", () => ({
      DescribeTableCommand: null,
      DynamoDBClient: class {},
      UpdateItemCommand: null,
    }));
    const store = new DynamoDbCredentialRateLimitStore("rate-table");
    await expect(store.initialize()).rejects.toThrow("does not expose the required constructors");
  });

  it("materializes timeout options in the pinned SDK node handler", async () => {
    vi.doUnmock("@aws-sdk/client-dynamodb");
    const sdkModuleName = "@aws-sdk/client-dynamodb";
    const sdkModule: unknown = await import(sdkModuleName);
    if (
      typeof sdkModule !== "object" ||
      sdkModule === null ||
      !("DynamoDBClient" in sdkModule) ||
      typeof sdkModule.DynamoDBClient !== "function" ||
      !("DescribeTableCommand" in sdkModule) ||
      typeof sdkModule.DescribeTableCommand !== "function"
    ) {
      throw new Error("Expected the installed DynamoDB SDK constructors.");
    }
    const { DescribeTableCommand, DynamoDBClient } = sdkModule as unknown as InstalledDynamoDbSdk;
    const server = createServer((_request, response) => {
      response.statusCode = 500;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local test server.");
    const client = new DynamoDBClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-2",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 2,
      retryMode: "standard",
      requestHandler: {
        connectionTimeout: 1_000,
        requestTimeout: 2_000,
        throwOnRequestTimeout: true,
      },
    });
    try {
      await expect(
        client.send(new DescribeTableCommand({ TableName: "rate-table" })),
      ).rejects.toBeDefined();
      const handler = client.config.requestHandler;
      expect(handler.constructor.name).toBe("NodeHttpHandler");
      expect(handler.httpHandlerConfigs?.()).toEqual(
        expect.objectContaining({
          connectionTimeout: 1_000,
          requestTimeout: 2_000,
          throwOnRequestTimeout: true,
        }),
      );
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
