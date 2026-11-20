/**
 * Eval suite: golden tasks replayed against each harness / model, scored by the app.
 *
 * A project keeps its suites in `.flashmaster/evals/*.json` (shared through git):
 *   { "name": "Brake ECU golden tasks",
 *     "targets": ["", "copilot/claude-sonnet-5.5", "pi/qwen-local/qwen3-coder"],   // "" = the usual harness and model
 *     "cases": [{ "id": "debounce-test", "title": "Unit test for the debounce",
 *                 "prompt": "Add a unit test for the brake light debounce …", "timeoutMinutes": 20,
 *                 "expect": { "status": "done", "checks": true, "files": ["tests/test_debounce.c"],
 *                             "contains": ["debounce"], "regex": "20\\s*ms", "maxTokens": 400000, "maxMinutes": 15 } }] }
 *
 * Each case runs in a throwaway git worktree of the project's current commit, as a fresh coordinator chat on the target.
 * When the request is done, the specialists' branches are merged into that copy (it is thrown away afterwards) and the
 * expectations are checked: the coordinator's result status, the project's checks, files, text, tokens and time.
 * Results are stored per batch, so the Evals page shows the pass rate per target and flags regressions against the
 * previous batch (a model that changed under you shows up before users notice).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessId } from "@shared/types";
import { HARNESS_IDS } from "@shared/types";
import type { EvalCaseResult, EvalExpect, EvalSuite } from "@shared/types";
import type { Db } from "./db";
import type { Orchestrator } from "./orchestrator";
import { createWorktree, defaultGit, removeWorktree, type Git } from "./worktree";
import { loadChecks, runChecks, type CheckRunner } from "./checks";
import { parseResult } from "./context";
import type { TraceStore } from "./traces";
import type { EvalProgress } from "@shared/types";
import type { Settings } from "@shared/settings";


export type { EvalCaseResult, EvalExpect, EvalSuite };

export const EVALS_DIR = join(".flashmaster", "evals");

/** Read every suite of a project; a broken file comes back with `error` and no cases. */
export function loadSuites(projectPath: string): EvalSuite[] {
  const dir = join(projectPath, EVALS_DIR);
  if (!existsSync(dir)) return [];
  const out: EvalSuite[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<EvalSuite>;
      const cases = (Array.isArray(j.cases) ? j.cases : []).filter((c) => c && typeof c.id === "string" && typeof c.prompt === "string" && c.prompt.trim());
      out.push({ file: f, name: typeof j.name === "string" && j.name.trim() ? j.name : f.replace(/\.json$/, ""),
        targets: Array.isArray(j.targets) && j.targets.length ? j.targets.map(String) : [""], cases: cases.map((c) => ({ ...c, title: c.title || c.id, expect: c.expect ?? {} })) });
    } catch (e) {
      out.push({ file: f, name: f, targets: [""], cases: [], error: `not valid JSON: ${String((e as Error).message ?? e).slice(0, 120)}` });
    }
  }
  return out;
}

/** "copilot/claude-sonnet-5.5" → harness + model; "pi/provider/model" keeps the provider in the model; "" = defaults. */
export function parseTarget(t: string): { harness: HarnessId | null; model: string | null; label: string } {
  const s = t.trim();
  if (!s) return { harness: null, model: null, label: "default" };
  const [h, ...rest] = s.split("/");
  if ((HARNESS_IDS as string[]).includes(h!)) return { harness: h as HarnessId, model: rest.join("/") || null, label: s };
  return { harness: null, model: s, label: s };
}

export interface Observed {
  /** The coordinator's final status (from its result block; "done" when it wrote none). */
  status: string;
  /** The coordinator's final reply (what the user would read). */
  reply: string;
  tokens: number;
  ms: number;
  timedOut: boolean;
  /** null = no checks set up; otherwise whether they passed on the merged copy. */
  checksOk: boolean | null;
  /** Which of the expected files exist in the merged copy. */
  files: Record<string, boolean>;
}

/** Score one run against its expectations: one line per expectation, passed only when all hold. */
export function scoreCase(expect: EvalExpect, o: Observed): { passed: boolean; score: number; assertions: { name: string; ok: boolean; detail: string }[] } {
  const a: { name: string; ok: boolean; detail: string }[] = [];
  a.push({ name: "finished", ok: !o.timedOut, detail: o.timedOut ? "timed out" : `in ${Math.round(o.ms / 1000)} s` });
  if (expect.status) a.push({ name: `status ${expect.status}`, ok: o.status === expect.status, detail: `was ${o.status}` });
  if (expect.checks) a.push({ name: "checks pass", ok: o.checksOk === true, detail: o.checksOk === null ? "no checks set up" : o.checksOk ? "passed" : "failed" });
  for (const f of expect.files ?? []) a.push({ name: `file ${f}`, ok: !!o.files[f], detail: o.files[f] ? "exists" : "missing" });
  for (const c of expect.contains ?? []) a.push({ name: `reply mentions "${c}"`, ok: o.reply.toLowerCase().includes(c.toLowerCase()), detail: "" });
  if (expect.regex) {
    let ok = false;
    try { ok = new RegExp(expect.regex, "i").test(o.reply); } catch { /* bad pattern fails */ }
    a.push({ name: `reply matches /${expect.regex}/`, ok, detail: "" });
  }
  if (expect.maxTokens) a.push({ name: `≤ ${expect.maxTokens.toLocaleString()} tokens`, ok: o.tokens <= expect.maxTokens, detail: `${o.tokens.toLocaleString()} used` });
  if (expect.maxMinutes) a.push({ name: `≤ ${expect.maxMinutes} min`, ok: o.ms <= expect.maxMinutes * 60_000, detail: `${(o.ms / 60_000).toFixed(1)} min` });
  const ok = a.filter((x) => x.ok).length;
  return { passed: ok === a.length, score: a.length ? ok / a.length : 0, assertions: a };
}

/** Compare a batch with the one before it: a case that passed and now fails, or costs ≥ 50 % more tokens, is a regression. */
export function regressions(latest: EvalCaseResult[], previous: EvalCaseResult[]): Map<string, string> {
  const key = (r: EvalCaseResult) => `${r.suite}\u0000${r.caseId}\u0000${r.target}`;
  const prev = new Map(previous.map((r) => [key(r), r]));
  const out = new Map<string, string>();
  for (const r of latest) {
    const p = prev.get(key(r));
    if (!p) continue;
    if (p.passed && !r.passed) out.set(r.id, "passed before, fails now");
    else if (p.tokens > 0 && r.tokens >= p.tokens * 1.5 && r.tokens - p.tokens > 5000) out.set(r.id, `tokens up ${Math.round((r.tokens / p.tokens - 1) * 100)}%`);
  }
  return out;
}

export const newBatchId = () => `${new Date().toISOString().slice(0, 16).replace("T", " ")} ${randomUUID().slice(0, 4)}`;

// ------------------------------------------------------------------ runner


export interface EvalRunnerDeps {
  db: Db;
  orch: Orchestrator;
  settings: () => Settings;
  emit: (p: EvalProgress) => void;
  git?: Git;
  checkRunner?: CheckRunner;
  /** Labels each run's trace "Eval · <case> (<target>)" on the Timeline. */
  traces?: TraceStore;
  /** Polling interval while a case runs (tests use a short one). */
  pollMs?: number;
  log?: (msg: string) => void;
}

/** Runs suites one case at a time (agents are a shared, budgeted resource) and stores each result. */
export class EvalRunner {
  private progress: EvalProgress = { running: false, batch: null, done: 0, total: 0, current: null };
  private cancelled = false;
  constructor(private d: EvalRunnerDeps) {}

  get state(): EvalProgress { return { ...this.progress }; }
  cancel(): void { this.cancelled = true; }

  private set(p: Partial<EvalProgress>): void { this.progress = { ...this.progress, ...p }; this.d.emit(this.state); }

  /** Run every case of the project's suites (or one suite) on every target. Resolves with the batch's results. */
  async run(projectId: string, o: { suite?: string; caseId?: string; targets?: string[] } = {}): Promise<EvalCaseResult[]> {
    if (this.progress.running) throw new Error("an eval batch is already running");
    const p = this.d.db.getProject(projectId);
    if (!p) throw new Error("unknown project");
    const suites = loadSuites(p.path).filter((s) => (!o.suite || s.file === o.suite) && !s.error);
    const jobs = suites.flatMap((s) => s.cases.filter((c) => !o.caseId || c.id === o.caseId)
      .flatMap((c) => (o.targets?.length ? o.targets : s.targets).map((t) => ({ s, c, t }))));
    if (!jobs.length) throw new Error(`no eval cases in ${EVALS_DIR}`);
    const batch = newBatchId();
    this.cancelled = false;
    this.set({ running: true, batch, done: 0, total: jobs.length, current: null });
    const out: EvalCaseResult[] = [];
    try {
      for (const [i, j] of jobs.entries()) {
        if (this.cancelled) break;
        this.set({ current: `${j.c.title} · ${parseTarget(j.t).label}`, done: i });
        out.push(await this.runCase(p.id, p.path, j.s, j.c, j.t, batch));
      }
    } finally {
      this.set({ running: false, current: null, done: out.length });
    }
    return out;
  }

  private async runCase(projectId: string, repo: string, suite: EvalSuite, c: EvalSuite["cases"][number], target: string, batch: string): Promise<EvalCaseResult> {
    const git = this.d.git ?? defaultGit;
    const id = randomUUID();
    const short = id.slice(0, 8);
    const dir = join(repo, ".wt", `eval-${short}`);
    const branch = `flash/eval-${short}`;
    const started = Date.now();
    const tgt = parseTarget(target);
    let evalProject: { id: string } | null = null;
    let chatId: string | null = null;
    let observed: Observed = { status: "failed", reply: "", tokens: 0, ms: 0, timedOut: false, checksOk: null, files: {} };
    let traceId: string | null = null;
    try {
      const wt = await createWorktree(repo, dir, branch, git);
      if (!wt.ok) throw new Error(wt.message);
      evalProject = this.d.db.createProject(`eval · ${c.id}`, dir);
      const chat = this.d.db.createChat({ projectId: evalProject.id, title: `Eval: ${c.title} (${tgt.label})`, kind: "project", agentRole: "flashmaster" });
      chatId = chat.id;
      if (tgt.harness || tgt.model) this.d.db.updateChat(chat.id, { harness: tgt.harness, model: tgt.model });
      await this.d.orch.sendUserMessage(chat.id, c.prompt, null);
      const limit = Math.max(1, c.timeoutMinutes ?? 30) * 60_000;
      const poll = this.d.pollMs ?? 1000;
      let quietSince = 0;
      let timedOut = false;
      for (;;) {
        await new Promise((r) => setTimeout(r, poll));
        if (this.d.orch.chatSettled(chat.id)) { quietSince ||= Date.now(); if (Date.now() - quietSince >= poll * 3) break; } else quietSince = 0;
        if (Date.now() - started > limit || this.cancelled) { timedOut = true; break; }
      }
      if (timedOut) await this.d.orch.stopChat(chat.id);
      const coord = this.d.orch.chatCoordinator(chat.id);
      traceId = coord?.traceId ?? null;
      if (traceId) this.d.traces?.labelRoot(traceId, `Eval · ${c.title} (${tgt.label})`, { "flash.eval.suite": suite.file, "flash.eval.case": c.id, "flash.eval.target": tgt.label });
      const replies = this.d.db.listMessages(chat.id, null).filter((m) => m.author === "agent");
      const reply = replies.at(-1)?.content ?? "";
      // The copy is thrown away: bring the specialists' branches in so the checks and files see their work.
      for (const a of this.d.db.listAgents({}).filter((x) => x.chatId === chat.id && x.worktree && x.branch)) {
        await this.d.orch.mergeWork(a.id, true).catch(() => null);
      }
      const cfg = loadChecks(dir, this.d.settings().checks?.commands ?? "");
      const checksOk = c.expect.checks && cfg.checks.length
        ? (await runChecks(dir, cfg.checks, { runner: this.d.checkRunner, defaultTimeoutMinutes: this.d.settings().checks?.timeoutMinutes || 15 })).ok : null;
      observed = { status: parseResult(reply).status ?? "done", reply, tokens: coord ? this.d.orch.requestTokens(coord.agentId)?.used ?? 0 : 0, ms: Date.now() - started, timedOut,
        checksOk, files: Object.fromEntries((c.expect.files ?? []).map((f) => [f, existsSync(join(dir, f))])) };
    } catch (e) {
      observed = { ...observed, reply: `error: ${String((e as Error)?.message ?? e)}`, ms: Date.now() - started };
      this.d.log?.(`eval ${c.id}: ${observed.reply}`);
    } finally {
      if (chatId) {
        await this.d.orch.stopChat(chatId).catch(() => {});
        for (const a of this.d.db.listAgents({}).filter((x) => x.chatId === chatId && x.worktree && x.branch)) await removeWorktree(dir, a.worktree!, a.branch!, true, git).catch(() => null);
        this.d.db.deleteChat(chatId);
      }
      if (evalProject) this.d.db.removeProject(evalProject.id);
      await removeWorktree(repo, dir, branch, true, git).catch(() => null);
    }
    const s = scoreCase(c.expect, observed);
    const r: EvalCaseResult = { id, suite: suite.file, caseId: c.id, target, batch, projectId, passed: s.passed, score: s.score, tokens: observed.tokens, ms: observed.ms,
      traceId, at: Date.now(), assertions: s.assertions, reply: observed.reply.slice(0, 4000) };
    this.d.db.saveEvalRun(r);
    return r;
  }
}
