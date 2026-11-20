/**
 * Checks before merge: the app, not the model, runs the project's own build / test / lint / static-analysis commands in
 * an agent's worktree. A failure goes straight back to that agent with the output; Merge is gated on a green run of
 * the branch's current commit (the user can still override).
 *
 * Where the commands come from, first match wins:
 *   1. <project>/.flashmaster/checks.json — shared with the team through git:
 *        { "checks": [ { "name": "Unit tests", "command": "npm test", "timeoutMinutes": 10 }, "npm run lint" ] }
 *   2. Settings → Checks → Default check commands — one per line, optionally `Name: command`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { killTree, spawnTool } from "./harness/process";
import { shellCommand } from "./hooks";
import type { CheckResult, CheckRun } from "@shared/types";

export type { CheckResult, CheckRun };

export interface CheckSpec { name: string; command: string; timeoutMinutes?: number }
export interface ChecksConfig { checks: CheckSpec[]; source: "project" | "settings" | "none"; error?: string }

export type CheckRunner = (command: string, cwd: string, timeoutMs: number, env: Record<string, string>) =>
  Promise<{ code: number | null; out: string; timedOut: boolean }>;

export const CHECKS_FILE = join(".flashmaster", "checks.json");
const OUTPUT_TAIL = 4000;

function toSpec(x: unknown, i: number): CheckSpec | null {
  if (typeof x === "string") return x.trim() ? { name: x.trim().split(/\s+/).slice(0, 3).join(" "), command: x.trim() } : null;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const command = typeof o.command === "string" ? o.command.trim() : "";
    if (!command) return null;
    const t = Number(o.timeoutMinutes);
    return { name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : `Check ${i + 1}`, command, ...(t > 0 ? { timeoutMinutes: t } : {}) };
  }
  return null;
}

/** Parse the settings text: one command per line, `Name: command` gives it a name; `#` lines are comments. */
export function parseCheckLines(text: string): CheckSpec[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const m = /^([^:]{1,40}):\s+(.+)$/.exec(l);
    // "C:\tools\x.exe" or "http://…" are commands, not names.
    return m?.[1] && m[2] && !/^[A-Za-z]$/.test(m[1]) && !/^\w+:\/\//.test(l) ? { name: m[1].trim(), command: m[2].trim() } : { name: l.split(/\s+/).slice(0, 3).join(" "), command: l };
  });
}

/** The checks for a project folder (null = no project: settings only). */
export function loadChecks(projectPath: string | null, settingsText: string): ChecksConfig {
  if (projectPath) {
    const f = join(projectPath, CHECKS_FILE);
    if (existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as unknown;
        const list = Array.isArray(j) ? j : (j as { checks?: unknown }).checks;
        if (!Array.isArray(list)) return { checks: [], source: "project", error: `${CHECKS_FILE} needs a "checks" list` };
        return { checks: list.map(toSpec).filter((x): x is CheckSpec => !!x), source: "project" };
      } catch (e) {
        return { checks: [], source: "project", error: `${CHECKS_FILE} is not valid JSON: ${String((e as Error).message ?? e).slice(0, 120)}` };
      }
    }
  }
  const checks = parseCheckLines(settingsText);
  return { checks, source: checks.length ? "settings" : "none" };
}

export const defaultCheckRunner: CheckRunner = (command, cwd, timeoutMs, env) => new Promise((resolve) => {
  const [cmd, args] = shellCommand(command);
  let out = "";
  let child: ReturnType<typeof spawnTool>;
  try {
    child = spawnTool(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd, env: { ...process.env, CI: "1", ...env }, windowsVerbatimArguments: process.platform === "win32" });
  } catch (e) { resolve({ code: -1, out: String(e), timedOut: false }); return; }
  const keep = (d: Buffer | string) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); };
  const t = setTimeout(() => { killTree(child); resolve({ code: null, out, timedOut: true }); }, timeoutMs);
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e), timedOut: false }); });
  child.on("close", (code) => { clearTimeout(t); resolve({ code, out, timedOut: false }); });
});

/** Keep the end of the output (failures are reported last), without ANSI colours. */
export function tailOutput(out: string, max = OUTPUT_TAIL): string {
  // eslint-disable-next-line no-control-regex
  const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?!\n)/g, "\n").trim();
  return clean.length <= max ? clean : `…\n${clean.slice(-max)}`;
}

/** Run the checks one after another in `cwd`. All run even after a failure, so the agent sees every problem at once. */
export async function runChecks(cwd: string, checks: CheckSpec[], o: { runner?: CheckRunner; defaultTimeoutMinutes: number; env?: Record<string, string>;
  head?: string | null; dirty?: boolean; onProgress?: (c: CheckSpec, i: number) => void; now?: () => number }): Promise<CheckRun> {
  const runner = o.runner ?? defaultCheckRunner;
  const now = o.now ?? Date.now;
  const results: CheckResult[] = [];
  for (const [i, c] of checks.entries()) {
    o.onProgress?.(c, i);
    const started = now();
    const r = await runner(c.command, cwd, Math.max(1, c.timeoutMinutes ?? o.defaultTimeoutMinutes) * 60_000, o.env ?? {});
    results.push({ name: c.name, command: c.command, ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, durationMs: now() - started, output: tailOutput(r.out) });
  }
  return { ok: results.every((r) => r.ok), head: o.head ?? null, dirty: !!o.dirty, at: now(), results };
}

/** One line for flows and results: "✓ 3/3 checks passed" or "✗ 1/3 checks failed: Unit tests". */
export function checksLine(run: CheckRun): string {
  const failed = run.results.filter((r) => !r.ok);
  return failed.length
    ? `✗ ${failed.length}/${run.results.length} check${run.results.length === 1 ? "" : "s"} failed: ${failed.map((r) => r.name + (r.timedOut ? " (timed out)" : "")).join(", ")}`
    : `✓ ${run.results.length}/${run.results.length} check${run.results.length === 1 ? "" : "s"} passed`;
}

/** The follow-up sent back to the agent when its checks fail. */
export function checksFixPrompt(run: CheckRun, round: number, maxRounds: number): string {
  const failed = run.results.filter((r) => !r.ok);
  return [
    `The project's checks failed on your work (round ${round} of ${maxRounds}). Fix the cause, commit, and finish with your result block again.`,
    ...failed.map((r) => `### ${r.name} — \`${r.command}\` ${r.timedOut ? "timed out" : `exited ${r.code}`}\n\`\`\`\n${r.output.slice(-2500) || "(no output)"}\n\`\`\``),
    "Don't weaken, skip or delete tests or checks to make them pass; if a check itself is wrong, say so in your result instead.",
  ].join("\n\n");
}

/** The checks part of the result the delegating agent gets. */
export function checksForParent(run: CheckRun, gaveUp: boolean): string {
  const lines = [`checks: ${checksLine(run)}`];
  if (gaveUp) {
    for (const r of run.results.filter((x) => !x.ok)) lines.push(`- ${r.name} (\`${r.command}\`): ${r.output.split("\n").slice(-6).join(" ⏎ ").slice(0, 400)}`);
    lines.push("The branch can't be merged until its checks pass (the user can override). Retry with a follow-up, reassign, or tell the user what blocks it.");
  }
  return lines.join("\n");
}
