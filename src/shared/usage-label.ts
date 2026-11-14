/** One-line text of the Copilot usage meter (pure, so tests and both processes can use it). */
import type { CopilotBilling, CopilotUsage } from "./types";

const fmt = (v: number) => (Math.round(v * 100) / 100).toLocaleString();
export const unitName = (b: CopilotBilling) => (b.unit === "requests" ? "premium requests" : "credits");
const usd = (v: number) => `$${v.toFixed(2)}`;

export function usageLabel(u: CopilotUsage): string {
  const b = u.billing;
  if (b) {
    const parts = [`${fmt(b.used)} ${unitName(b)} used`];
    if (b.remaining !== null) parts.push(`${fmt(b.remaining)} left`);
    if (b.netAmount > 0 || b.budget !== null) parts.push(b.budgetRemaining !== null ? `${usd(b.netAmount)} of ${usd(b.budget!)} budget` : `${usd(b.netAmount)} billed`);
    if (b.models[0]) parts.push(`top: ${b.models[0].model} ${b.models[0].share}%`);
    return `Copilot · ${parts.join(" · ")}`;
  }
  const p = u.premium;
  if (p.unlimited) return `Copilot premium requests: unlimited${p.used !== null ? ` · ${p.used} used` : ""}`;
  const parts = [p.used !== null && p.limit !== null ? `${p.used} / ${p.limit}` : p.used !== null ? `${p.used} used` : "", p.percent !== null ? `${p.percent}%` : ""];
  const nums = parts.filter(Boolean).join(" · ");
  if (!nums) return `Copilot usage · ${u.entries[0] ? `${u.entries[0].label}: ${u.entries[0].value}` : "see details"}`;
  return `Copilot premium · ${nums}${u.resetAt ? ` · resets ${u.resetAt}` : ""}`;
}
