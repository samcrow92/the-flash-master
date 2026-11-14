import { describe, expect, it } from "vitest";
import { fetchCopilotBilling, parseEntitlement, summarizeBilling, type Fetch } from "../src/main/github-billing";
import { usageLabel } from "../src/shared/usage-label";

const credit = (model: string, gross: number, discount: number, price = 0.01) => ({
  product: "Copilot", sku: "AI Credit", model, unitType: "ai-credits", pricePerUnit: price,
  grossQuantity: gross, grossAmount: gross * price, discountQuantity: discount, discountAmount: discount * price,
  netQuantity: gross - discount, netAmount: (gross - discount) * price,
});

type Route = { status?: number; body: unknown };
function fakeFetch(routes: Record<string, Route>): Fetch & { calls: string[]; auth: string[] } {
  const calls: string[] = [];
  const auth: string[] = [];
  const f = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    auth.push(init?.headers?.Authorization ?? "");
    const path = url.replace("https://api.github.com", "");
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => path === k || (path.startsWith(k) && (k.endsWith("/") || "?/".includes(path[k.length]!))));
    const r = key ? routes[key]! : { status: 404, body: { message: "Not Found" } };
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  }) as Fetch & { calls: string[]; auth: string[] };
  f.calls = calls;
  f.auth = auth;
  return f;
}
const now = new Date("2026-11-14T12:00:00Z");

describe("Copilot billing summary", () => {
  it("totals credits and ranks models by what they consume", () => {
    const b = summarizeBilling([credit("GPT-5", 300, 300), credit("Claude Opus 5.5", 900, 600), credit("gpt-5", 100, 100), { product: "Actions", grossQuantity: 999 }],
      { year: 2026, month: 11 }, "mari", { allowance: 1500, budget: 10 });
    expect(b).toMatchObject({ unit: "ai-credits", used: 1300, included: 1000, billed: 300, netAmount: 3, remaining: 500, budget: 10, budgetRemaining: 7 });
    expect(b.models.map((m) => [m.model, m.quantity, m.share])).toEqual([["Claude Opus 5.5", 900, 69.2], ["GPT-5", 400, 30.8]]);
  });

  it("keeps premium-request accounts in their own unit and leaves unknown allowance empty", () => {
    const b = summarizeBilling([{ product: "Copilot", model: "GPT-5", unitType: "requests", grossQuantity: 12, discountQuantity: 12 }], { year: 2026, month: 11 }, "mari");
    expect(b).toMatchObject({ unit: "requests", used: 12, allowance: null, remaining: null, budgetRemaining: null });
  });

  it("reads the included allowance from Copilot's entitlement", () => {
    expect(parseEntitlement({ quota_reset_date: "2026-12-01", quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, unlimited: false } } }))
      .toEqual({ allowance: 300, remaining: 120, resetAt: "2026-12-01" });
    expect(parseEntitlement({ quota_snapshots: { premium_interactions: { unlimited: true, entitlement: 0 } } })).toBeNull();
    expect(parseEntitlement({ message: "nope" })).toBeNull();
  });
});

describe("fetching from GitHub's billing API", () => {
  it("asks for this month's AI credits of the token's user and shows used, left and the top model", async () => {
    const f = fakeFetch({
      "/user": { body: { login: "mari" } },
      "/users/mari/settings/billing/ai_credit/usage": { body: { usageItems: [credit("Claude Opus 5.5", 800, 800), credit("GPT-5", 200, 200)] } },
      "/copilot_internal/user": { body: { quota_reset_date: "2026-12-01", quota_snapshots: { ai_credits: { entitlement: 1500, remaining: 500 } } } },
    });
    const u = await fetchCopilotBilling(f, "tok", { now });
    expect(f.calls).toContain("https://api.github.com/users/mari/settings/billing/ai_credit/usage?year=2026&month=11");
    expect(f.auth.every((a) => a === "Bearer tok")).toBe(true);
    expect(u).toMatchObject({ ok: true, source: "github", resetAt: "2026-12-01", premium: { used: 1000, limit: 1500 } });
    expect(u.billing).toMatchObject({ used: 1000, remaining: 500, allowance: 1500 });
    expect(usageLabel(u)).toBe("Copilot · 1,000 credits used · 500 left · top: Claude Opus 5.5 80%");
  });

  it("falls back to premium requests when the account has no AI credit usage", async () => {
    const f = fakeFetch({
      "/user": { body: { login: "mari" } },
      "/users/mari/settings/billing/ai_credit/usage": { body: { usageItems: [] } },
      "/users/mari/settings/billing/premium_request/usage": { body: { usageItems: [{ product: "Copilot", model: "GPT-5", unitType: "requests", grossQuantity: 40, discountQuantity: 30, netQuantity: 10, netAmount: 0.4 }] } },
    });
    const u = await fetchCopilotBilling(f, "tok", { now, allowance: 300 });
    expect(u.billing).toMatchObject({ unit: "requests", used: 40, remaining: 270, netAmount: 0.4 });
    expect(usageLabel(u)).toMatch(/40 premium requests used · 270 left · \$0\.40 billed/);
  });

  it("explains a token without the Plan permission instead of showing an empty meter", async () => {
    const f = fakeFetch({
      "/user": { body: { login: "mari" } },
      "/users/mari/settings/billing": { status: 403, body: { message: "Resource not accessible by personal access token" } },
    });
    await expect(fetchCopilotBilling(f, "tok", { now })).rejects.toThrow(/Plan → Read-only/);
    await expect(fetchCopilotBilling(fakeFetch({ "/user": { status: 401, body: {} } }), "tok", { now })).rejects.toThrow(/expired or revoked/);
    await expect(fetchCopilotBilling(f, "", { now })).rejects.toThrow(/No GitHub token/);
  });

  it("shows zero usage when the month has none yet", async () => {
    const f = fakeFetch({ "/user": { body: { login: "mari" } }, "/users/mari/settings/billing/": { body: { usageItems: [] } } });
    const u = await fetchCopilotBilling(f, "tok", { now, budget: 20 });
    expect(u.ok).toBe(true);
    expect(u.billing).toMatchObject({ used: 0, models: [], budgetRemaining: 20 });
    expect(u.premium.percent).toBe(0); // with a budget the bar tracks spending beyond the plan
    expect(u.resetAt).toBe("2026-12-01");
  });
});
