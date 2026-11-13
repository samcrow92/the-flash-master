/**
 * Copilot usage meter: the data comes only from GitHub Copilot CLI's own `/usage` command (run over ACP in a
 * throw-away session). The output is free text that changes between CLI versions, so the parser is tolerant:
 * it looks for "used / limit" pairs and percentages near "premium", a reset date, and keeps every "label: value"
 * line plus the raw text for the detailed view.
 */
import type { CopilotUsage } from "@shared/types";

const num = (s: string) => Number(s.replace(/[,\s_]/g, ""));

export function parseCopilotUsage(raw: string, fetchedAt = Date.now()): CopilotUsage {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  const lines = text.split("\n").map((l) => l.replace(/^[\s│|•*\-–>]+/, "").replace(/[\s│|]+$/, "")).filter(Boolean);

  const entries: { label: string; value: string }[] = [];
  for (const l of lines) {
    const m = /^([A-Za-z][\w .()/'-]{1,60}?)\s*[:：]\s+(.+)$/.exec(l) ?? /^([A-Za-z][\w .()/'-]{1,60}?)\s{2,}(\S.*)$/.exec(l);
    if (m) entries.push({ label: m[1]!.trim(), value: m[2]!.trim() });
  }

  let used: number | null = null;
  let limit: number | null = null;
  let percent: number | null = null;
  let unlimited = false;
  const premiumLines = lines.filter((l) => /premium/i.test(l));
  const scan = premiumLines.length ? premiumLines : lines.filter((l) => /quota|request|usage|entitlement/i.test(l));
  for (const l of scan) {
    if (/unlimited/i.test(l)) unlimited = true;
    const pair = /(\d[\d,._]*(?:\.\d+)?)\s*(?:\/|of|out of)\s*(\d[\d,._]*)/i.exec(l);
    if (pair && used === null) { used = num(pair[1]!); limit = num(pair[2]!); }
    const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(l);
    if (pct && percent === null) percent = Number(pct[1]);
    if (used === null) {
      const single = /(\d[\d,._]*(?:\.\d+)?)\s+premium\s+requests?/i.exec(l) ?? /premium\s+requests?[^\d]{0,30}(\d[\d,._]*(?:\.\d+)?)/i.exec(l);
      if (single) used = num(single[1]!);
    }
    const remaining = /(\d[\d,._]*)\s+(?:premium\s+requests?\s+)?remaining/i.exec(l);
    if (remaining && used !== null && limit === null && !pair) limit = used + num(remaining[1]!);
  }
  if (percent === null && used !== null && limit) percent = Math.round((used / limit) * 1000) / 10;
  if (limit !== null && used === null && percent !== null) used = Math.round((percent / 100) * limit);

  const resetLine = lines.find((l) => /reset|renew|refresh(es)? on|billing (cycle|period)/i.test(l));
  const resetAt = resetLine ? (/(?:resets?|renews?|refresh(?:es)?)(?:\s+(?:on|at|in))?\s*[:：]?\s*(.+)$/i.exec(resetLine)?.[1] ?? resetLine).trim() : null;

  const ok = used !== null || percent !== null || unlimited || entries.length > 0;
  return {
    ok, fetchedAt, error: ok ? null : (text.trim() ? "could not read premium request numbers from /usage" : "/usage returned no text"),
    premium: { used, limit: unlimited ? null : limit, percent: unlimited ? null : percent, unlimited },
    resetAt, entries: entries.slice(0, 40), raw: text.trim().slice(0, 8000),
  };
}
