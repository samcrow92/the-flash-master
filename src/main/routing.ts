/**
 * Routing and best-of-N: code decides, agents don't spend tokens on it.
 *
 * - `routeByDifficulty`: a cheap, deterministic guess at how hard a delegated brief is, mapped to the drive modes the
 *   user already set up (Settings → Modes: ECO / COMFORT / SPORT). Used only when Settings → Agents → Route by
 *   difficulty is on and the coordinator named no harness, model or mode.
 * - `rankAttempts`: picks the winner among N parallel attempts at one task (each in its own worktree): green checks
 *   first, then a finished result, then the smallest change.
 */
import type { CheckRun } from "@shared/types";

export type RouteMode = "eco" | "comfort" | "sport";
export const ROUTE_MODES: RouteMode[] = ["eco", "comfort", "sport"];

const HARD = /\b(root[- ]cause|rca|architect\w*|design|refactor\w*|race condition|deadlock|concurren\w*|memory leak|safety|asil|iso ?26262|misra|security|vulnerab\w*|migrat\w*|optimi[sz]\w*|performance|timing analysis|bootloader|scheduler|interrupt|multi[- ]?core|spec(?:ification)?s?\b|trade-?offs?|ambiguous|investigat\w*|debug\w*|flaky|intermittent)\b/i;
const EASY = /\b(list|find|search|look ?up|locate|grep|read|summari[sz]e|rename|typo|format\w*|translate|count|show|print|check (?:if|whether)|which file|where is|status|changelog|bump|update (?:the )?version|add (?:a )?comment)\b/i;

/** How hard a brief looks, and why (shown in the progress flow). */
export function routeByDifficulty(text: string): { mode: RouteMode; reason: string } {
  const t = text.slice(0, 4000);
  const hard = HARD.exec(t);
  if (hard) return { mode: "sport", reason: `looks hard ("${hard[0]}")` };
  const files = (t.match(/[\w./\\-]+\.\w{1,5}\b/g) ?? []).length;
  const easy = EASY.exec(t);
  if (easy && t.length < 600 && files <= 3) return { mode: "eco", reason: `looks simple ("${easy[0]}")` };
  return { mode: "comfort", reason: "ordinary task" };
}

export interface Attempt {
  agentId: string;
  name: string | null;
  branch: string | null;
  /** "done" | "failed" | "stopped" | … (the specialist's final status) */
  status: string;
  result: string;
  checks: CheckRun | null;
  /** Lines added + removed on its branch (null = unknown). */
  changed: number | null;
}

/** Score for sorting: higher is better. Checks: passed 2, none set up 1, failed 0. */
function score(a: Attempt): [number, number, number] {
  const checks = a.checks ? (a.checks.ok ? 2 : 0) : 1;
  const finished = /^error:|^stopped|status:\s*(failed|blocked)/i.test(a.result) || a.status === "failed" ? 0 : 1;
  const size = a.changed === null ? -1e9 : a.changed > 0 ? -a.changed : -1e8; // no change at all ranks last
  return [checks, finished, size];
}

/** Attempts best first. Ties keep their order (the first to start wins). */
export function rankAttempts(list: Attempt[]): Attempt[] {
  return list.map((a, i) => ({ a, i, s: score(a) })).sort((x, y) => {
    for (let k = 0; k < 3; k++) if (x.s[k] !== y.s[k]) return y.s[k]! - x.s[k]!;
    return x.i - y.i;
  }).map((x) => x.a);
}

/** The combined result the delegating agent gets for a best-of-N delegation. */
export function attemptsReport(ranked: Attempt[]): string {
  const [best, ...rest] = ranked;
  if (!best) return "error: no attempt ran";
  const line = (a: Attempt) => `- ${a.name ?? a.agentId} (agentId ${a.agentId}${a.branch ? `, branch ${a.branch}` : ""}): `
    + `${a.checks ? (a.checks.ok ? "checks passed" : "checks failed") : "no checks"}, ${a.changed ?? "?"} lines changed`;
  return [
    `## Best of ${ranked.length} attempts: ${best.name ?? best.agentId} wins`,
    best.result,
    `### All attempts (best first)\n${ranked.map(line).join("\n")}`,
    rest.length ? `The other attempts' branches are kept for the user (Review page); merge only the winner unless the user picks another. Follow up on the winner with agentId ${best.agentId}.` : "",
  ].filter(Boolean).join("\n\n");
}
