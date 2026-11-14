/**
 * Copilot usage from GitHub's billing API (usage-based billing: AI credits since June 2026, premium requests before).
 *
 * Copilot CLI's own `/usage` only describes the session it runs in, so it can never show what the account has
 * spent this month. These endpoints do, per model:
 *   GET /users/{user}/settings/billing/ai_credit/usage?year&month       (unitType "ai-credits")
 *   GET /users/{user}/settings/billing/premium_request/usage?year&month (unitType "requests", legacy/annual plans)
 * Both need a token with the "Plan" user permission (read). The plan's included allowance is not in the billing API;
 * it comes from Copilot's own entitlement endpoint when the token may read it, or from the user's setting.
 */
import type { CopilotBilling, CopilotUsage } from "@shared/types";

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export interface BillingItem {
  product?: string; sku?: string; model?: string; unitType?: string; pricePerUnit?: number;
  grossQuantity?: number; grossAmount?: number; discountQuantity?: number; discountAmount?: number; netQuantity?: number; netAmount?: number;
}

export interface BillingOptions {
  /** Plan allowance per month in the billing unit; 0/undefined = read it from Copilot when possible. */
  allowance?: number;
  /** Monthly spending budget in USD; 0/undefined = none. */
  budget?: number;
}

export const PLAN_PERMISSION_HINT =
  "Use a fine-grained token with Account permissions → Plan → Read-only (github.com → Settings → Developer settings → Fine-grained tokens), and paste it in Settings → Usage.";

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Totals and a per-model breakdown (largest first) of billing usage items. Items of other products are ignored. */
export function summarizeBilling(items: BillingItem[], period: { year: number; month: number }, user: string, opts: BillingOptions = {}): CopilotBilling {
  const copilot = items.filter((i) => !i.product || /copilot/i.test(i.product));
  const unit: CopilotBilling["unit"] = copilot.some((i) => /credit/i.test(i.unitType ?? "")) || !copilot.length ? "ai-credits" : "requests";
  const byModel = new Map<string, { model: string; quantity: number; amount: number; netAmount: number }>();
  let used = 0, included = 0, billed = 0, grossAmount = 0, netAmount = 0;
  let price: number | null = null;
  for (const i of copilot) {
    const q = n(i.grossQuantity);
    used += q; included += n(i.discountQuantity); billed += n(i.netQuantity);
    grossAmount += n(i.grossAmount); netAmount += n(i.netAmount);
    if (price === null && n(i.pricePerUnit) > 0) price = n(i.pricePerUnit);
    const name = (i.model ?? "").trim() || "Other";
    const m = byModel.get(name.toLowerCase()) ?? { model: name, quantity: 0, amount: 0, netAmount: 0 };
    m.quantity += q; m.amount += n(i.grossAmount); m.netAmount += n(i.netAmount);
    byModel.set(name.toLowerCase(), m);
  }
  const models = [...byModel.values()]
    .filter((m) => m.quantity > 0 || m.amount > 0)
    .sort((a, b) => b.quantity - a.quantity || b.amount - a.amount)
    .map((m) => ({ model: m.model, quantity: round(m.quantity), amount: round(m.amount), netAmount: round(m.netAmount), share: used > 0 ? round((m.quantity / used) * 100, 1) : 0 }));
  const allowance = opts.allowance && opts.allowance > 0 ? opts.allowance : null;
  const budget = opts.budget && opts.budget > 0 ? opts.budget : null;
  return {
    unit, period, user,
    used: round(used), included: round(included), billed: round(billed), grossAmount: round(grossAmount), netAmount: round(netAmount), pricePerUnit: price,
    allowance, remaining: allowance !== null ? round(Math.max(0, allowance - included)) : null,
    budget, budgetRemaining: budget !== null ? round(Math.max(0, budget - netAmount)) : null,
    models,
  };
}

/**
 * The included allowance from Copilot's entitlement endpoint (the one Copilot's editors use for their quota display).
 * Returns null when it is not readable or has no limited quota; never throws.
 */
export function parseEntitlement(body: any): { allowance: number; remaining: number | null; resetAt: string | null } | null {
  const snaps = body?.quota_snapshots;
  if (!snaps || typeof snaps !== "object") return null;
  const snap = snaps.ai_credits ?? snaps.premium_interactions ?? snaps.premium_requests
    ?? Object.values(snaps).find((s: any) => s && typeof s === "object" && /credit|premium/i.test(String(s.quota_id ?? "")));
  if (!snap || snap.unlimited || !(n(snap.entitlement) > 0)) return null;
  return { allowance: n(snap.entitlement), remaining: typeof snap.remaining === "number" ? snap.remaining : null, resetAt: body.quota_reset_date ?? snap.quota_reset_date ?? null };
}

export class BillingError extends Error {}

function explain(status: number, what: string, body: string): string {
  if (status === 401) return `GitHub rejected the token (expired or revoked). ${PLAN_PERMISSION_HINT}`;
  if (status === 403 || status === 404) {
    return `The token can't read ${what} (HTTP ${status}). ${PLAN_PERMISSION_HINT} If your Copilot seat is paid by an organization, its usage is billed there and is not visible on your account.`;
  }
  const msg = (() => { try { return JSON.parse(body)?.message as string | undefined; } catch { return undefined; } })();
  return `GitHub billing API answered HTTP ${status}${msg ? `: ${msg}` : ""}`;
}

/** Fetches this month's Copilot usage for the token's user. Throws BillingError with a readable message. */
export async function fetchCopilotBilling(fetch: Fetch, token: string, opts: BillingOptions & { api?: string; now?: Date } = {}): Promise<CopilotUsage> {
  if (!token) throw new BillingError(`No GitHub token to read Copilot billing. ${PLAN_PERMISSION_HINT}`);
  const api = (opts.api ?? "https://api.github.com").replace(/\/+$/, "");
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
  const get = async (path: string, what: string) => {
    const r = await fetch(`${api}${path}`, { headers });
    if (!r.ok) throw Object.assign(new BillingError(explain(r.status, what, await r.text().catch(() => ""))), { status: r.status });
    return r.json();
  };
  const me = await get("/user", "your GitHub account");
  const login = String(me?.login ?? "");
  if (!login) throw new BillingError("GitHub did not say which account the token belongs to");
  const now = opts.now ?? new Date();
  const period = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const q = `year=${period.year}&month=${period.month}`;
  const base = `/users/${encodeURIComponent(login)}/settings/billing`;

  // AI credits first; accounts still on premium requests (annual plans) report there instead.
  let items: BillingItem[] = [];
  let creditErr: unknown = null;
  try { items = (await get(`${base}/ai_credit/usage?${q}`, "Copilot AI credit usage"))?.usageItems ?? []; } catch (e) { creditErr = e; }
  if (!items.length) {
    try {
      const legacy: BillingItem[] = (await get(`${base}/premium_request/usage?${q}`, "Copilot premium request usage"))?.usageItems ?? [];
      if (legacy.length) items = legacy;
    } catch { if (creditErr) throw creditErr; }
  }

  let allowance = opts.allowance && opts.allowance > 0 ? opts.allowance : 0;
  let resetAt: string | null = null;
  try {
    const r = await fetch(`${api}/copilot_internal/user`, { headers });
    const ent = r.ok ? parseEntitlement(await r.json()) : null;
    if (ent) { if (!allowance) allowance = ent.allowance; resetAt = ent.resetAt; }
  } catch { /* the allowance is optional */ }
  if (!resetAt) resetAt = new Date(Date.UTC(period.year, period.month, 1)).toISOString().slice(0, 10);

  const billing = summarizeBilling(items, period, login, { allowance, budget: opts.budget });
  return toUsage(billing, resetAt);
}

/** Fills the generic meter fields from billing totals, so every view that reads `premium` keeps working. */
export function toUsage(b: CopilotBilling, resetAt: string | null, fetchedAt = Date.now()): CopilotUsage {
  const limit = b.allowance;
  // With a budget, the bar tracks spending beyond the plan (what can still run out); otherwise the included allowance.
  const percent = b.budget ? round(Math.min(100, (b.netAmount / b.budget) * 100), 1) : limit ? round(Math.min(100, (b.included / limit) * 100), 1) : null;
  return {
    ok: true, fetchedAt, error: null, source: "github", billing: b,
    premium: { used: b.used, limit, percent, unlimited: false },
    resetAt, entries: [], raw: "",
  };
}
