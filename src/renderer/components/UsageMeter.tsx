import type { CopilotUsage } from "@shared/types";
import { api, useStore } from "../store";

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const level = (p: number) => (p >= 90 ? "crit" : p >= 75 ? "warn" : "ok");

export function usageLabel(u: CopilotUsage): string {
  const p = u.premium;
  if (p.unlimited) return `Copilot premium requests: unlimited${p.used !== null ? ` · ${p.used} used` : ""}`;
  const parts = [p.used !== null && p.limit !== null ? `${p.used} / ${p.limit}` : p.used !== null ? `${p.used} used` : "", p.percent !== null ? `${p.percent}%` : ""];
  return `Copilot premium · ${parts.filter(Boolean).join(" · ")}${u.resetAt ? ` · resets ${u.resetAt}` : ""}`;
}

/** Thin progress bar under the chat box. Data only from Copilot's /usage. */
export function UsageMeter() {
  const st = useStore();
  const u = st.copilotUsage;
  const enabled = st.settings?.usage?.copilotMeter;
  if (!enabled || !u || (!u.ok && !u.loading)) return null;
  const pct = u.premium.percent;
  const open = () => st.setView({ kind: "settings", tab: "usage" });
  return (
    <div className="usage-meter" title={`From Copilot /usage · updated ${ago(u.fetchedAt)} — click for details`}>
      <button className="usage-bar-btn" onClick={open}>
        <div className="usage-bar"><div className={`usage-fill ${pct !== null ? level(pct) : ""}`} style={{ width: `${Math.min(100, pct ?? (u.premium.unlimited ? 0 : 0))}%` }} /></div>
        <span className="usage-text">{usageLabel(u)}</span>
      </button>
      <button className="ghost tiny" disabled={u.loading} onClick={() => api().copilotUsage(true)} title="Refresh from Copilot /usage">{u.loading ? "…" : "↻"}</button>
    </div>
  );
}
