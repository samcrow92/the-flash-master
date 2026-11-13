import { useEffect } from "react";
import type { CopilotUsage } from "@shared/types";
import { api, useStore } from "../store";
import { CircleAlert, Gauge, Loader2, RotateCcw } from "./icons";

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const level = (p: number) => (p >= 90 ? "crit" : p >= 75 ? "warn" : "ok");

export function usageLabel(u: CopilotUsage): string {
  const p = u.premium;
  if (p.unlimited) return `Copilot premium requests: unlimited${p.used !== null ? ` · ${p.used} used` : ""}`;
  const parts = [p.used !== null && p.limit !== null ? `${p.used} / ${p.limit}` : p.used !== null ? `${p.used} used` : "", p.percent !== null ? `${p.percent}%` : ""];
  const nums = parts.filter(Boolean).join(" · ");
  if (!nums) return `Copilot usage · ${u.entries[0] ? `${u.entries[0].label}: ${u.entries[0].value}` : "see details"}`;
  return `Copilot premium · ${nums}${u.resetAt ? ` · resets ${u.resetAt}` : ""}`;
}

/** Thin progress bar under the chat box. Data only from Copilot's /usage; always shows its state. */
export function UsageMeter() {
  const st = useStore();
  const u = st.copilotUsage;
  const cfg = st.settings?.usage;
  // Check on first view when there is no fresh data (e.g. Copilot was set up after the app started).
  useEffect(() => {
    if (!cfg?.copilotMeter) return;
    const stale = !u || Date.now() - u.fetchedAt > Math.max(5, cfg.refreshMinutes || 30) * 60000;
    if (stale && !u?.loading) void api().copilotUsage(true);
  }, [cfg?.copilotMeter]);
  if (!cfg?.copilotMeter) return null;
  const open = () => st.setView({ kind: "settings", tab: "usage" });
  const refresh = <button className="ghost tiny" disabled={u?.loading} onClick={() => api().copilotUsage(true)} title="Refresh from Copilot /usage">
    {u?.loading ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}</button>;

  if (!u || (u.loading && !u.ok)) {
    return <div className="usage-meter"><button className="usage-bar-btn" onClick={open}><Gauge size={13} className="muted" /><span className="usage-text">{u?.loading ? "Checking Copilot usage…" : "Copilot usage not checked yet"}</span></button>{refresh}</div>;
  }
  // Off Windows, Copilot is one harness among several (Cursor, Claude Code…): don't nag when it isn't installed.
  if (!u.ok && u.error === "Copilot CLI not found" && st.window && st.window.platform !== "win32") return null;
  if (!u.ok) {
    return (
      <div className="usage-meter warn" title={u.error ?? ""}>
        <button className="usage-bar-btn" onClick={open}><CircleAlert size={13} /><span className="usage-text">Copilot usage unavailable — {u.error ?? "no data"} (details)</span></button>{refresh}
      </div>
    );
  }
  const pct = u.premium.percent;
  return (
    <div className="usage-meter" title={`From Copilot /usage · updated ${ago(u.fetchedAt)} — click for details`}>
      <button className="usage-bar-btn" onClick={open}>
        {pct !== null ? <div className="usage-bar"><div className={`usage-fill ${level(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} /></div> : <Gauge size={13} className="muted" />}
        <span className="usage-text">{usageLabel(u)}</span>
      </button>
      {refresh}
    </div>
  );
}
