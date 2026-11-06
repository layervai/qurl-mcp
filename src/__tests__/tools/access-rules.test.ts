import { describe, expect, it, vi } from "vitest";
import type { AccessRules } from "@layervai/qurl";
import { listAccessRulesTool } from "../../tools/access-rules.js";
import { publishCridTool } from "../../tools/consumer-access.js";
import { batchCreateSchema } from "../../tools/batch-create.js";
import { createQurlTool } from "../../tools/create-qurl.js";
import { makeMockClient, sampleCreateQURLData } from "../helpers.js";

const rules: AccessRules = {
  account_id: "acct-test",
  version: 2,
  quick_share_rule_id: "review",
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Acme team",
      mode: "email_domain",
      email_domain: "acme.com",
      allowed_emails: ["Partner@outside.example"],
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Quick look",
      mode: "public",
      link_limits: { expires_in: "1h", session_duration: "30m" },
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Paid",
      mode: "contract",
      contract_id: "sale",
      payment: { price_id: "price_123", access_seconds: 0 },
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Weekly approvals",
      mode: "review",
      approval_expires_in: "7d",
    },
  ],
  built_ins: [
    { id: "builtin.public", name: "Anyone with the link", mode: "public" },
    { id: "builtin.keys", name: "Devices you approve", mode: "keys" },
  ],
};
const [domainRule, publicRule, paidRule, reviewRule] = rules.items;
const text = (result: { content: Array<{ text?: string }> }) => result.content[0].text ?? "";
const rulesClient = (overrides = {}) =>
  makeMockClient({ getAccessRules: vi.fn().mockResolvedValue(rules), ...overrides });

describe("list_access_rules", () => {
  it("lists rules and built-ins without account or Quick share internals", async () => {
    const result = await listAccessRulesTool(rulesClient()).handler({});
    expect(result.structuredContent).toEqual({ items: rules.items, built_ins: rules.built_ins });
    expect(text(result)).not.toContain("quick_share_rule_id");
    expect(text(result)).not.toContain("acct-test");
  });

  it("reports an unrecognized library instead of throwing", async () => {
    const client = makeMockClient({
      getAccessRules: vi.fn().mockResolvedValue({ ...rules, items: [{ id: "x" }] }),
    });
    const result = await listAccessRulesTool(client).handler({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unrecognized access rules");
  });
});

describe("create_qurl with rule_id", () => {
  it("applies a public rule's link limits with an explicit reusable flag", async () => {
    const client = rulesClient({
      createQURL: vi.fn().mockResolvedValue({ data: sampleCreateQURLData() }),
    });
    const result = await createQurlTool(client, { mode: "stdio" }).handler({
      target_url: "https://example.com",
      rule_id: publicRule.id,
    });
    expect(result.isError).not.toBe(true);
    expect(client.createQURL).toHaveBeenCalledWith({
      target_url: "https://example.com",
      expires_in: "1h",
      one_time_use: false,
      session_duration: "30m",
    });
  });

  it.each([
    [
      { rule_id: "builtin.public", expires_in: "2h" },
      { expires_in: "2h", one_time_use: false },
    ],
    [{ rule_id: "once-rule" }, { expires_in: "30d", one_time_use: true, session_duration: "24h" }],
  ])("uses %j as %j", async (input, sent) => {
    const client = makeMockClient({
      getAccessRules: vi.fn().mockResolvedValue({
        ...rules,
        items: [
          {
            id: "once-rule",
            name: "Once",
            mode: "public",
            link_limits: { expires_in: "30d", one_time_use: true, session_duration: "24h" },
          },
        ],
      }),
      createQURL: vi.fn().mockResolvedValue({ data: sampleCreateQURLData() }),
    });
    await createQurlTool(client, { mode: "stdio" }).handler({
      target_url: "https://example.com",
      ...input,
    });
    expect(client.createQURL).toHaveBeenCalledWith({ target_url: "https://example.com", ...sent });
  });

  it("propagates a refused rules read without creating", async () => {
    const client = makeMockClient({ getAccessRules: vi.fn().mockRejectedValue(new Error("403")) });
    await expect(
      createQurlTool(client, { mode: "stdio" }).handler({
        target_url: "https://example.com",
        rule_id: publicRule.id,
      }),
    ).rejects.toThrow("403");
    expect(client.createQURL).not.toHaveBeenCalled();
  });

  it.each([
    [{ rule_id: domainRule.id }, "Use publish_crid"],
    [{ rule_id: "future-rule" }, "cannot use"],
    [{ rule_id: "builtin.unknown" }, "No access rule"],
    [{ rule_id: publicRule.id, expires_in: "2h" }, "omit them"],
  ])("refuses %j before creating", async (input, message) => {
    const client = rulesClient({
      getAccessRules: vi.fn().mockResolvedValue({
        ...rules,
        items: [...rules.items, { id: "future-rule", name: "Future", mode: "future_mode" }],
      }),
    });
    const result = await createQurlTool(client, { mode: "stdio" }).handler({
      target_url: "https://example.com",
      ...input,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(client.createQURL).not.toHaveBeenCalled();
  });
});

describe("publish_crid with rule_id", () => {
  const receipt = (consumer_access: object) => ({
    crid: "a".repeat(60),
    details: { resource_id: "r_test1234567", crid: "a".repeat(60), private: true, consumer_access },
  });

  it.each([
    [
      domainRule,
      {
        mode: "email_domain",
        version: 1,
        email_domain: "acme.com",
        allowed_emails: ["Partner@outside.example"],
      },
    ],
    [reviewRule, { mode: "review", version: 1, approval_expires_in: "7d" }],
    [rules.built_ins[1], { mode: "keys", version: 1 }],
    [
      { id: "contract-rule", name: "Custom", mode: "contract", contract_id: "sale" },
      { mode: "contract", version: 1, contract_id: "sale" },
    ],
  ])("publishes the policy of rule %#", async (rule, policy) => {
    const client = makeMockClient({
      getAccessRules: vi.fn().mockResolvedValue({ ...rules, items: [...rules.items, rule] }),
      protectUrl: vi.fn().mockResolvedValue(receipt(policy)),
    });
    const result = await publishCridTool(client).handler({
      target_url: "https://example.com",
      rule_id: rule.id,
    });
    expect(result.isError).not.toBe(true);
    expect(client.protectUrl).toHaveBeenCalledWith("https://example.com", {
      consumerAccess: policy,
    });
    expect(result.structuredContent).toMatchObject({ consumer_access: policy });
  });

  it.each([
    [{ rule_id: publicRule.id }, "Use create_qurl"],
    [{ rule_id: paidRule.id }, "takes payment"],
    [{ rule_id: "future-rule" }, "cannot publish"],
    [{}, "exactly one"],
    [{ rule_id: reviewRule.id, policy: { mode: "review", version: 1 } }, "exactly one"],
  ])("refuses %j before publishing", async (input, message) => {
    const client = makeMockClient({
      getAccessRules: vi.fn().mockResolvedValue({
        ...rules,
        items: [...rules.items, { id: "future-rule", name: "Future", mode: "future_mode" }],
      }),
    });
    const result = await publishCridTool(client).handler({
      target_url: "https://example.com",
      ...input,
    } as never);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(client.protectUrl).not.toHaveBeenCalled();
  });
});

it("does not offer rule_id on batch items", () => {
  const parsed = batchCreateSchema.safeParse({
    items: [{ target_url: "https://example.com", rule_id: publicRule.id }],
  });
  expect(parsed.success && "rule_id" in parsed.data.items[0]).toBe(false);
});
