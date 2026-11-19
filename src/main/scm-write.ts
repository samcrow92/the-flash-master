/**
 * IBM EWM source control — making changes: repository workspaces, sandboxes, check-in, change sets, accept and deliver.
 * EWM has no public REST API for any of this, so everything goes through the EWM SCM command line (scm.exe / lscm), the
 * same one the read-only folder listings use, signed in with the Jazz user and password from Settings (scm-cli.ts).
 *
 * Rules (tests/invariants.test.ts checks them):
 *  - Every command that changes something goes through `change()`, which refuses in read-only mode (Settings → Permissions).
 *  - Code changes only in a repository workspace. A stream is never loaded, checked in to or accepted into: it changes
 *    only by deliver.
 *  - Deliver also needs Settings → Integrations → IBM Jazz → Source control → "Agents may deliver", and `confirm` must
 *    repeat the target stream's name. Discard needs `confirm` = the change set.
 *  - Sandboxes are folders the caller (tools.ts) has already placed inside the agent's working folder.
 */
import type { CliRunner } from "./scm";

export interface ScmWorkspace { name: string; id?: string; owner?: string; description?: string; stream?: string }
export interface ScmChangeset { id: string; alias?: string; comment?: string; author?: string; date?: string; complete?: boolean; workItems?: string[] }
export interface ScmWriteDeps {
  cli: () => { run: CliRunner; repo: string } | null;
  readOnly: () => boolean;
  allowDeliver: () => boolean;
  /** Stream names visible on the server (REST), to refuse a stream where a repository workspace is needed. */
  streamNames?: () => Promise<string[]>;
}

const MAX_OUT = 12_000;

/** One command-line value: trimmed, single line, and never something the CLI would read as an option. */
export function cliArg(v: unknown, what: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(`${what} is required`);
  if (/[\r\n\0]/.test(s)) throw new Error(`${what} must be a single line`);
  if (s.startsWith("-")) throw new Error(`${what} may not start with "-"`);
  if (s.length > 300) throw new Error(`${what} is too long`);
  return s;
}
/** A check-in or change set comment: one line, no leading dashes (the CLI would read them as an option). */
export function cliComment(v: unknown): string {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\0/g, "").trim().replace(/^-+\s*/, "").slice(0, 1000);
}

/** JSON from the CLI when it printed some (its shapes differ between EWM versions), else null. */
export function parseCliJson(out: string): unknown {
  const t = out.trim();
  const i = t.search(/[[{]/);
  if (i < 0) return null;
  try { return JSON.parse(t.slice(i)); } catch { return null; }
}
const walk = (v: unknown, visit: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(v)) { v.forEach((x) => walk(x, visit)); return; }
  if (v && typeof v === "object") { visit(v as Record<string, unknown>); Object.values(v).forEach((x) => walk(x, visit)); }
};
const str = (x: unknown) => typeof x === "string" ? x : typeof x === "number" ? String(x) : undefined;

/** Repository workspaces from `scm list workspaces --json`: objects with a name and a uuid. */
export function parseWorkspaces(out: string): ScmWorkspace[] {
  const seen = new Map<string, ScmWorkspace>();
  walk(parseCliJson(out), (o) => {
    const name = str(o.name), id = str(o.uuid) ?? str(o.itemId);
    if (!name || !id || seen.has(id) || "workspaces" in o) return;
    const owner = o.owner && typeof o.owner === "object" ? str((o.owner as any).name) ?? str((o.owner as any).userId) : str(o.owner);
    const flow = o["flow-target"] ?? o.flowTarget ?? o.target;
    const stream = flow && typeof flow === "object" ? str((flow as any).name) : str(flow);
    seen.set(id, { name, id, ...(owner ? { owner } : {}), ...(str(o.desc) ?? str(o.description) ? { description: (str(o.desc) ?? str(o.description))!.slice(0, 200) } : {}), ...(stream ? { stream } : {}) });
  });
  return [...seen.values()];
}

/** Change sets from `scm list changesets` / `checkin` / `show status` JSON: objects with a uuid and a comment, alias or author. */
export function parseChangesets(out: string): ScmChangeset[] {
  const seen = new Map<string, ScmChangeset>();
  walk(parseCliJson(out), (o) => {
    const id = str(o.uuid);
    if (!id || seen.has(id) || !("comment" in o || "alias" in o || "author" in o || "state" in o)) return;
    if ("components" in o || "workspaces" in o) return;
    const author = o.author && typeof o.author === "object" ? str((o.author as any).name) ?? str((o.author as any).userId) : str(o.author);
    const wis = Array.isArray(o.workitems) ? (o.workitems as any[]).map((w) => str(w?.["workitem-number"]) ?? str(w?.id) ?? str(w?.label)).filter((x): x is string => !!x) : [];
    const state = str(o.state) ?? "";
    seen.set(id, {
      id, ...(str(o.alias) ? { alias: str(o.alias) } : {}), ...(str(o.comment) ? { comment: str(o.comment)!.slice(0, 300) } : {}),
      ...(author ? { author } : {}), ...(str(o.modified) ?? str(o.date) ? { date: str(o.modified) ?? str(o.date) } : {}),
      ...(state ? { complete: /complete|closed/i.test(state) && !/incomplete|open/i.test(state) } : {}), ...(wis.length ? { workItems: wis } : {}),
    });
  });
  return [...seen.values()];
}

/** Compact result: the JSON the CLI printed (capped), or the last lines of its text. */
export function compactOutput(out: string): unknown {
  const j = parseCliJson(out);
  if (j !== null) {
    const s = JSON.stringify(j);
    return s.length <= MAX_OUT ? j : { truncated: true, json: s.slice(0, MAX_OUT) };
  }
  const lines = out.trim().split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-60).join("\n").slice(-MAX_OUT);
}

const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-4).join(" ").slice(0, 600);
/** Conflicts and gaps the CLI reports in words (it exits non-zero for them on most versions). */
const CONFLICT = /conflict|unresolved|gap|would.*overwrite|out of sync|not up to date|merge/i;

export class ScmWriter {
  constructor(private d: ScmWriteDeps) {}

  private cli() {
    const c = this.d.cli();
    if (!c) throw new Error("EWM source control changes need the EWM SCM command line (scm.exe or lscm from the EWM client). Install it or set its path in Settings → Integrations → IBM Jazz → Source control.");
    return c;
  }

  /** Read-only commands (list, show). */
  private async read(cmd: string[], rest: string[]): Promise<string> {
    const c = this.cli();
    const r = await c.run([...cmd, "-r", c.repo, ...rest]);
    if (r.code !== 0) throw new Error(`scm ${cmd.join(" ")} failed (${r.code}): ${tail(r)}`);
    return r.stdout;
  }

  /** Every command that changes the repository or a sandbox. Refused in read-only mode. */
  private async change(cmd: string[], rest: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    if (this.d.readOnly()) throw new Error("read-only mode is on (Settings → Permissions): nothing can be loaded, checked in, accepted or delivered in EWM");
    const c = this.cli();
    const r = await c.run([...cmd, "-r", c.repo, ...rest]);
    if (r.code !== 0) {
      const msg = tail(r);
      const hint = CONFLICT.test(`${r.stdout}\n${r.stderr}`) ? " — check scm_status for conflicts or incoming changes, accept them first, and resolve conflicts in the sandbox" : "";
      throw new Error(`scm ${cmd.join(" ")} failed (${r.code}): ${msg}${hint}`);
    }
    return r;
  }

  /** Refuses a stream name where a repository workspace is needed (checked against the server's streams when it answers). */
  private async notStream(name: string, what: string): Promise<void> {
    const names = await this.d.streamNames?.().catch(() => [] as string[]) ?? [];
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      throw new Error(`refused: “${name}” is a stream. ${what} only happens in a repository workspace: create one that flows to this stream with scm_create_workspace, load it, change files there, check in, then deliver.`);
    }
  }

  async workspaces(o: { name?: string; max?: number } = {}): Promise<ScmWorkspace[]> {
    const max = Math.min(Math.max(Math.floor(o.max ?? 50), 1), 500);
    const out = await this.read(["list", "workspaces"], ["-m", String(max), ...(o.name ? ["-n", cliArg(o.name, "name")] : []), "--json"]);
    return parseWorkspaces(out);
  }

  async createWorkspace(name: string, stream: string, description?: string): Promise<{ workspace: string; stream: string; output: unknown }> {
    const ws = cliArg(name, "workspace name"), st = cliArg(stream, "stream");
    await this.notStream(ws, "Working on files");
    const desc = cliComment(description);
    const r = await this.change(["create", "workspace"], ["-s", st, ...(desc ? ["--description", desc] : []), ws, "--json"]);
    return { workspace: ws, stream: st, output: compactOutput(r.stdout) };
  }

  /** Loads a repository workspace (all components, or the ones named) into a sandbox folder. */
  async load(workspace: string, dir: string, components: string[] = [], force = false): Promise<{ workspace: string; output: unknown }> {
    const ws = cliArg(workspace, "workspace");
    await this.notStream(ws, "Loading for changes");
    const comps = components.slice(0, 50).map((c) => cliArg(c, "component"));
    const r = await this.change(["load"], ["-d", cliArg(dir, "sandbox"), ...(force ? ["--force"] : []), ws, ...comps]);
    return { workspace: ws, output: compactOutput(r.stdout) };
  }

  /** Pending local changes, outgoing and incoming change sets, and conflicts of a sandbox. */
  async status(dir: string): Promise<unknown> {
    return compactOutput(await this.read(["show", "status"], ["-d", cliArg(dir, "sandbox"), "--json"]));
  }

  /** Checks local changes (files, folders, or the whole sandbox) in to a new change set, or to an existing one. */
  async checkin(paths: string[], o: { comment?: string; changeset?: string; workItem?: string } = {}): Promise<{ changesets: ScmChangeset[]; workItem?: string; output: unknown }> {
    if (!paths.length) throw new Error("nothing to check in: pass the sandbox or the files");
    const files = paths.slice(0, 200).map((p) => cliArg(p, "path"));
    const comment = cliComment(o.comment);
    const r = await this.change(["checkin"], [...(o.changeset ? ["-c", cliArg(o.changeset, "changeset")] : []), ...(comment ? ["--comment", comment] : []), "--json", ...files]);
    const changesets = parseChangesets(r.stdout);
    let wi: string | undefined;
    if (o.workItem) {
      wi = cliArg(o.workItem, "work item");
      const target = o.changeset ?? changesets[0]?.id;
      if (!target) throw new Error("checked in, but the change set id was not in the CLI output, so the work item was not linked — link it with scm_changeset_update");
      await this.change(["changeset", "associate"], [cliArg(target, "changeset"), wi]);
    }
    return { changesets, ...(wi ? { workItem: wi } : {}), output: changesets.length ? undefined : compactOutput(r.stdout) };
  }

  async changesets(workspace: string, o: { component?: string; max?: number } = {}): Promise<ScmChangeset[]> {
    const max = Math.min(Math.max(Math.floor(o.max ?? 25), 1), 200);
    const out = await this.read(["list", "changesets"], ["-w", cliArg(workspace, "workspace"), ...(o.component ? ["-C", cliArg(o.component, "component")] : []), "-m", String(max), "--json"]);
    return parseChangesets(out);
  }

  /** The files a change set touches. */
  async changes(changeset: string): Promise<unknown> {
    return compactOutput(await this.read(["list", "changes"], [cliArg(changeset, "changeset"), "--json"]));
  }

  /** Comment, link a work item, or complete a change set (completing can't be undone; a delivered change set is complete). */
  async updateChangeset(changeset: string, o: { comment?: string; workItem?: string; complete?: boolean }): Promise<{ changeset: string; done: string[] }> {
    const cs = cliArg(changeset, "changeset");
    const done: string[] = [];
    const comment = cliComment(o.comment);
    if (comment) { await this.change(["changeset", "comment"], [cs, comment]); done.push("comment"); }
    if (o.workItem) { await this.change(["changeset", "associate"], [cs, cliArg(o.workItem, "work item")]); done.push(`work item ${o.workItem}`); }
    if (o.complete) { await this.change(["changeset", "complete"], [cs]); done.push("complete"); }
    if (!done.length) throw new Error("nothing to change: pass comment, workItem or complete");
    return { changeset: cs, done };
  }

  /** Brings incoming change sets (all, or the ones named) from the flow target or a given stream into a repository workspace. */
  async accept(workspace: string, o: { source?: string; changesets?: string[]; sandbox?: string } = {}): Promise<{ workspace: string; output: unknown }> {
    const ws = cliArg(workspace, "workspace");
    await this.notStream(ws, "Accepting");
    const cs = (o.changesets ?? []).slice(0, 100).map((c) => cliArg(c, "changeset"));
    const r = await this.change(["accept"], ["-t", ws, ...(o.source ? ["-s", cliArg(o.source, "source")] : []), ...(o.sandbox ? ["-d", cliArg(o.sandbox, "sandbox")] : []), "--json", ...(cs.length ? ["-c", ...cs] : [])]);
    return { workspace: ws, output: compactOutput(r.stdout) };
  }

  /** Delivers outgoing change sets (all, or the ones named) from a repository workspace to a stream. */
  async deliver(workspace: string, stream: string, confirm: unknown, changesets: string[] = []): Promise<{ workspace: string; stream: string; output: unknown }> {
    if (!this.d.allowDeliver()) throw new Error("delivering is turned off: the user allows it in Settings → Integrations → IBM Jazz → Source control → Agents may deliver. Until then, tell the user which change sets are ready so they can deliver them.");
    const ws = cliArg(workspace, "workspace"), st = cliArg(stream, "stream");
    if (String(confirm ?? "").trim() !== st) throw new Error(`not delivered: confirm must repeat the target stream's name exactly ("${st}"). Deliver only when the user asked for it.`);
    await this.notStream(ws, "Delivering");
    const cs = changesets.slice(0, 100).map((c) => cliArg(c, "changeset"));
    const r = await this.change(["deliver"], ["-s", ws, "-t", st, "--json", ...(cs.length ? ["-c", ...cs] : [])]);
    return { workspace: ws, stream: st, output: compactOutput(r.stdout) };
  }

  /** Removes an undelivered change set from a repository workspace (its changes leave the sandbox too). */
  async discard(workspace: string, changeset: string, confirm: unknown): Promise<{ workspace: string; discarded: string; output: unknown }> {
    const ws = cliArg(workspace, "workspace"), cs = cliArg(changeset, "changeset");
    if (String(confirm ?? "").trim() !== cs) throw new Error(`not discarded: confirm must repeat the change set exactly ("${cs}"). Discard only when the user asked for it.`);
    await this.notStream(ws, "Discarding");
    const r = await this.change(["discard"], ["-w", ws, cs]);
    return { workspace: ws, discarded: cs, output: compactOutput(r.stdout) };
  }
}
