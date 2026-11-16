/** One-line text of the Copilot usage meter (pure, so tests and both processes can use it). */
import type { AgentRun, CopilotBilling, CopilotUsage } from "./types";

const fmt = (v: number) => (Math.round(v * 100) / 100).toLocaleString();
export const unitName = (b: CopilotBilling) => (b.unit === "requests" ? "premium requests" : "credits");

export function usageLabel(u: CopilotUsage): string {
  const b = u.billing;
  if (b) {
    const parts = b.available !== null && b.availableTotal !== null
      ? [`${fmt(b.available)} of ${fmt(b.availableTotal)} ${unitName(b)} available`, `${fmt(b.usedOfAvailable)} used (${b.percent}%)`]
      : [`${fmt(b.used)} ${unitName(b)} used this month`];
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

/** "12 credits", "1 credit", "0.33 premium requests" (unit from the meter's data). */
export function creditsText(n: number, unit: CopilotBilling["unit"] = "credits"): string {
  const word = unit === "requests" ? "premium request" : "credit";
  return `${fmt(n)} ${word}${Math.abs(n - 1) < 1e-9 ? "" : "s"}`;
}

/** Copilot credits counted for one chat: the total and each agent that used some, largest first. */
export function chatCredits(agents: Iterable<Pick<AgentRun, "id" | "chatId" | "role" | "name" | "credits">>, chatId: string | null) {
  const list = [...agents].filter((a) => chatId && a.chatId === chatId && a.credits > 0).sort((a, b) => b.credits - a.credits);
  return { total: Math.round(list.reduce((s, a) => s + a.credits, 0) * 100) / 100, agents: list };
}
