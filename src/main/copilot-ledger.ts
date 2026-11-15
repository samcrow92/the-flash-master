/**
 * Copilot usage from Copilot itself, with no GitHub calls and no token:
 *  - `/usage` run silently at the end of each Copilot turn in TheFlashMaster's own sessions (only when Copilot lists
 *    /usage as a built-in command, so it never reaches a model). It reports the session so far, per model.
 *  - Copilot CLI's own session log on this computer (~/.copilot/session-state/<id>/events.jsonl): every session that
 *    ended writes a `session.shutdown` event with per-model request counts, also for sessions outside the app.
 * Per session the shutdown records win; a live /usage snapshot counts only for the part after the last shutdown.
 * Neither source knows the account's allowance: that comes from Copilot via its sign-in (copilot-quota.ts), or else
 * from the user's setting, and then "available" is that minus what was used.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CopilotBilling, CopilotUsage } from "@shared/types";
import type { Quota } from "./copilot-quota";

export type Unit = CopilotBilling["unit"];
export interface Segment { at: number; total: number; models: Record<string, number>; unit?: Unit | null }
export interface LiveSnapshot extends Segment { sessionId: string }

const num = (s: string) => {
  const m = /^([\d.,]+)\s*([km])?$/i.exec(s.trim());
  if (!m) return NaN;
  const v = Number(m[1]!.replace(/,/g, ""));
  return m[2]?.toLowerCase() === "k" ? v * 1000 : m[2]?.toLowerCase() === "m" ? v * 1e6 : v;
};
const unitOf = (s: string): Unit | null => (/credit/i.test(s) ? "credits" : /premium|request/i.test(s) ? "requests" : null);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Reads Copilot CLI's `/usage` text: "Total usage est: 7 Premium requests" (or credits) and one line per model such as
 * "claude-sonnet-4.5   453.0k in, 13.1k out, 405.7k cached (Est. 7 Premium requests)". null when it has no total.
 */
export function parseSessionUsage(raw: string): Omit<Segment, "at"> | null {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  const total = /total\s+usage(?:\s+est\.?)?\s*[:：]?\s*([\d.,]+[km]?)\s+([a-z ]*(?:credits?|premium\s+requests?|requests?))/i.exec(text);
  const models: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^[\s│|•*-]*([A-Za-z][\w.:/-]*(?:\s[\w.:/-]+)?)\s{2,}.*\(\s*est\.?\s*([\d.,]+[km]?)\s+([a-z ]*?(?:credits?|premium\s+requests?|requests?))\s*\)/i.exec(line);
    if (m && !/^total/i.test(m[1]!)) models[m[1]!.trim()] = (models[m[1]!.trim()] ?? 0) + num(m[2]!);
  }
  if (!total && !Object.keys(models).length) return null;
  const sum = Object.values(models).reduce((a, b) => a + b, 0);
  return { total: total ? num(total[1]!) : sum, models, unit: unitOf(total?.[2] ?? text) };
}

/** The `session.shutdown` records of one Copilot session log (events.jsonl). */
export function parseShutdowns(jsonl: string): Segment[] {
  const out: Segment[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.includes("session.shutdown")) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "session.shutdown") continue;
    const at = Date.parse(e.timestamp ?? e.data?.timestamp ?? "") || 0;
    const models: Record<string, number> = {};
    for (const [model, m] of Object.entries<any>(e.data?.modelMetrics ?? {})) {
      const v = Number(m?.requests?.cost ?? m?.requests?.count ?? 0);
      if (v > 0) models[model] = v;
    }
    const sum = Object.values(models).reduce((a, b) => a + b, 0);
    const total = Number(e.data?.totalPremiumRequests ?? e.data?.totalCredits ?? sum) || sum;
    out.push({ at, total, models });
  }
  return out;
}

/** Copilot's home folder (COPILOT_HOME, else ~/.copilot). */
export const copilotHome = (home: string, env = process.env) => env.COPILOT_HOME || join(home, ".copilot");

/** Shutdown records per session id from Copilot's session logs changed since `since` (ms). Missing folder = none. */
export async function scanSessionLogs(copilotDir: string, since: number): Promise<Map<string, Segment[]>> {
  const out = new Map<string, Segment[]>();
  const root = join(copilotDir, "session-state");
  let ids: string[];
  try { ids = await readdir(root); } catch { return out; }
  await Promise.all(ids.map(async (id) => {
    const file = join(root, id, "events.jsonl");
    try {
      const st = await stat(file);
      if (st.mtimeMs < since || st.size > 64 * 1024 * 1024) return;
      const segs = parseShutdowns(await readFile(file, "utf8"));
      if (segs.length) out.set(id, segs);
    } catch { /* not a session folder */ }
  }));
  return out;
}

const monthStart = (y: number, m: number) => Date.UTC(y, m - 1, 1);

/** This month's usage from both sources, with available credits computed from the user's monthly credits. */
export function summarizeLocal(
  logs: Map<string, Segment[]>, live: LiveSnapshot[], period: { year: number; month: number },
  opts: { allowance?: number; unit?: Unit | null; quota?: Quota | null; signIn?: string | null } = {},
): CopilotBilling {
  const from = monthStart(period.year, period.month);
  const to = monthStart(period.year, period.month + 1);
  const inMonth = (t: number) => t >= from && t < to;
  const byModel = new Map<string, number>();
  let used = 0, sessions = 0, appSessions = 0;
  const add = (s: Segment) => {
    used += s.total;
    for (const [k, v] of Object.entries(s.models)) byModel.set(k, (byModel.get(k) ?? 0) + v);
    const rest = s.total - Object.values(s.models).reduce((a, b) => a + b, 0);
    if (rest > 0.0001) byModel.set("Other", (byModel.get("Other") ?? 0) + rest);
  };
  const ids = new Set([...logs.keys(), ...live.map((l) => l.sessionId)]);
  for (const id of ids) {
    const segs = logs.get(id) ?? [];
    const last = Math.max(0, ...segs.map((s) => s.at));
    let counted = false;
    for (const s of segs) if (inMonth(s.at)) { add(s); counted = true; }
    // A live snapshot covers the session since it (re)started; only count it when no shutdown came after it.
    const snap = live.filter((l) => l.sessionId === id && l.at > last).sort((a, b) => b.at - a.at)[0];
    if (snap && inMonth(snap.at)) { add(snap); counted = true; appSessions++; }
    if (counted) sessions++;
  }
  const q = opts.quota ?? null;
  const unit: Unit = q?.unit ?? opts.unit ?? live.find((l) => l.unit)?.unit ?? "credits";
  // Copilot's own numbers win; the setting is the fallback when Copilot can't be asked.
  const fromCopilot = !!q && !q.unlimited && q.entitlement !== null && q.remaining !== null;
  const setting = opts.allowance && opts.allowance > 0 ? opts.allowance : null;
  const allowance = fromCopilot ? q!.entitlement : setting;
  const available = fromCopilot ? Math.max(0, q!.remaining!) : allowance !== null ? Math.max(0, allowance - used) : null;
  const usedOfAvailable = allowance !== null && available !== null ? allowance - available : used;
  return {
    unit, period, used: round(used), sessions, appSessions,
    allowance, availableTotal: allowance, available: available !== null ? round(available) : null,
    availableFrom: available === null ? null : fromCopilot ? "copilot" : "setting",
    usedOfAvailable: round(usedOfAvailable),
    overage: q?.overage ?? 0, unlimited: !!q?.unlimited, plan: q?.plan ?? null, signIn: opts.signIn ?? null,
    percent: allowance ? round(Math.min(100, (usedOfAvailable / allowance) * 100), 1) : null,
    models: [...byModel.entries()].filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1])
      .map(([model, q]) => ({ model, quantity: round(q), share: used > 0 ? round((q / used) * 100, 1) : 0 })),
  };
}

export function toUsage(b: CopilotBilling, opts: { advertised?: boolean | null; commands?: string[]; fetchedAt?: number; quotaError?: string | null; resetAt?: string | null } = {}): CopilotUsage {
  const next = opts.resetAt ?? new Date(Date.UTC(b.period.year, b.period.month, 1)).toISOString().slice(0, 10);
  const notOffered = opts.advertised === false && b.sessions === 0;
  const notes = [
    opts.quotaError ? `${opts.quotaError}${b.availableFrom === "setting" ? " Using the credits you entered instead." : ""}` : "",
    notOffered ? `This Copilot CLI does not offer /usage to apps (commands: ${(opts.commands ?? []).slice(0, 12).join(", ") || "none"}), and no finished Copilot sessions were found on this computer yet, so there is no per-model breakdown. Update Copilot CLI.` : "",
  ].filter(Boolean);
  return {
    ok: true, source: "cli", billing: b, fetchedAt: opts.fetchedAt ?? Date.now(),
    error: notes.length ? notes.join(" ") : null,
    advertised: opts.advertised ?? undefined,
    premium: { used: b.usedOfAvailable, limit: b.availableTotal, percent: b.percent, unlimited: b.unlimited },
    resetAt: next, entries: [], raw: "",
  };
}

/** Live /usage snapshots of the app's sessions, kept for the current and previous month. */
export class LiveLedger {
  private snaps: LiveSnapshot[] = [];
  constructor(private load: () => string | null, private save: (json: string) => void) {
    try { this.snaps = JSON.parse(this.load() ?? "[]").filter((s: LiveSnapshot) => s && typeof s.sessionId === "string"); } catch { this.snaps = []; }
  }
  record(sessionId: string, seg: Omit<Segment, "at">, at = Date.now()): void {
    // /usage is cumulative per session: keep only the latest snapshot of each session.
    this.snaps = this.snaps.filter((s) => s.sessionId !== sessionId);
    this.snaps.push({ sessionId, at, ...seg });
    const keepFrom = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() - 1, 1);
    this.snaps = this.snaps.filter((s) => s.at >= keepFrom);
    try { this.save(JSON.stringify(this.snaps)); } catch { /* best effort */ }
  }
  all(): LiveSnapshot[] { return [...this.snaps]; }
}
