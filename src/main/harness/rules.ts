/**
 * Permission rules: argv-level allow / ask / deny for agent tool calls, instead of searching the call's text for a
 * substring. A command line is split into its parts (`a && b | c`), each part is tokenized (quotes respected) and the
 * leading wrappers that only change *how* it runs (`sudo`, `env X=1`, `cmd /c`, `powershell -Command`) are peeled off,
 * so `sudo  rm   -rf /` and `cmd /c "rm -rf /"` both match `deny rm -rf /*`.
 *
 * Rule syntax, one per line (`#` starts a comment):
 *   [role:] allow|ask|deny [kind] pattern
 *   deny  git push --force*        — a command (execute calls)
 *   ask   git push *               — `x *` also matches `x` alone
 *   tester: allow npm test*        — only for the tester role
 *   deny  edit **∕.env             — a path rule for edit / delete / move / read calls (glob, ** crosses folders)
 *   deny  fetch *                  — any web fetch
 * Precedence: deny > ask > allow. A compound command is allowed by rules only when every part is.
 */
import type { ToolKind } from "./types";

export type RuleAction = "allow" | "ask" | "deny";
export const RULE_ACTIONS: RuleAction[] = ["allow", "ask", "deny"];
const RULE_KINDS: ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "fetch", "other"];
const PATH_KINDS: ToolKind[] = ["read", "edit", "delete", "move"];

export interface PermRule {
  action: RuleAction;
  /** Only for this role (role name, e.g. "tester"); undefined = every agent. */
  role?: string;
  /** "execute" = command rule (the default); a path kind = path rule; fetch/search/other match the call's title. */
  kind: ToolKind;
  pattern: string;
  /** The line as written, shown when a rule decides. */
  source: string;
}

export interface RuleCall {
  kind: ToolKind;
  /** The command line (execute calls). */
  command?: string | null;
  /** Paths the call touches. */
  paths?: string[];
  /** The tool call's title (fallback text for fetch/search/other, and for execute when no command is known). */
  title?: string;
  role?: string;
}

export interface RuleDecision { decision: RuleAction; rule: string }

/** Parse the rules text; bad lines come back in `errors` (1-based line number + reason) and are skipped. */
export function parseRules(text: string): { rules: PermRule[]; errors: string[] } {
  const rules: PermRule[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    let rest = line;
    let role: string | undefined;
    const rm = /^([\w-]+):\s+(.*)$/.exec(rest);
    if (rm?.[1] && rm[2] !== undefined && !RULE_ACTIONS.includes(rm[1].toLowerCase() as RuleAction)) { role = rm[1].toLowerCase(); rest = rm[2]; }
    const [first, ...tail] = rest.split(/\s+/);
    const action = first?.toLowerCase() as RuleAction;
    if (!RULE_ACTIONS.includes(action)) { errors.push(`line ${i + 1}: start with allow, ask or deny`); return; }
    let kind: ToolKind = "execute";
    const k0 = (tail[0] ?? "").toLowerCase() as ToolKind;
    if (tail.length > 1 && RULE_KINDS.includes(k0)) { kind = k0; tail.shift(); }
    else if (tail.length === 1 && RULE_KINDS.includes(k0)) { kind = k0; tail[0] = "*"; }
    const pattern = tail.join(" ").trim();
    if (!pattern) { errors.push(`line ${i + 1}: missing a pattern`); return; }
    rules.push({ action, role, kind, pattern, source: raw.trim() });
  });
  return { rules, errors };
}

/** Split a shell line into tokens, keeping quoted parts together (quotes removed). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "", quote: string | null = null, has = false;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ""; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Split a command line into its parts at `&&`, `||`, `;`, `|`, `&` and new lines (outside quotes). */
export function splitCommand(line: string): string[] {
  const parts: string[] = [];
  let cur = "", quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      if ((ch === "|" || ch === "&") && line[i + 1] === ch) i++;
      parts.push(cur); cur = ""; continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const WRAPPERS = new Set(["sudo", "doas", "nohup", "time", "exec", "command", "builtin", "nice"]);

/**
 * The command a part really runs, as normalized tokens: wrappers, `VAR=value` prefixes, `env`, `cmd /c` and
 * `powershell -Command` are peeled off (their inner command is split again, so `bash -c "a && b"` gives two parts).
 */
export function commandParts(line: string, depth = 0): string[][] {
  const out: string[][] = [];
  for (const part of splitCommand(line)) {
    let t = tokenize(part);
    for (;;) {
      const t0 = t[0];
      if (t0 === undefined) break;
      const head = t0.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
      if (WRAPPERS.has(head)) { t = t.slice(1); continue; }
      if (/^[A-Za-z_][\w]*=/.test(t0)) { t = t.slice(1); continue; }
      if (head === "env") { t = t.slice(1); while (t[0]?.startsWith("-")) t = t.slice(1); continue; }
      const inner = (flags: RegExp) => {
        const i = t.findIndex((x, k) => k > 0 && flags.test(x));
        return i > 0 ? t.slice(i + 1).join(" ") : null;
      };
      let sub: string | null = null;
      if (head === "cmd") sub = inner(/^\/[ck]$/i);
      else if (head === "powershell" || head === "pwsh") sub = inner(/^-(c|command)$/i);
      else if (["sh", "bash", "zsh", "dash"].includes(head)) sub = inner(/^-\w*c$/);
      if (sub !== null && depth < 3) { out.push(...commandParts(sub, depth + 1)); t = []; }
      break;
    }
    if (t.length) out.push(t);
  }
  return out;
}

function globToRegExp(pattern: string, path: boolean): RegExp {
  let p = pattern.trim();
  const optionalTail = !path && p.endsWith(" *");
  if (optionalTail) p = p.slice(0, -2);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (path && p[i + 1] === "*") { re += ".*"; i++; if (p[i + 1] === "/") i++; continue; }
      re += path ? "[^/]*" : ".*";
    } else if (ch === "?") re += path ? "[^/]" : ".";
    else if (!path && ch === " ") re += "\\s+";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  if (optionalTail) re += "(?:\\s.*)?";
  return new RegExp(`^${re}$`, "is");
}

/** True when the (normalized) command matches the pattern. Matching ignores case: Windows commands are case-insensitive. */
export function matchCommand(pattern: string, tokens: string[]): boolean {
  return globToRegExp(pattern.trim().replace(/\s+/g, " "), false).test(tokens.join(" "));
}

/** True when the path matches the glob. Backslashes count as `/`; a pattern without a folder part matches the file name. */
export function matchPath(pattern: string, path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const g = pattern.replace(/\\/g, "/");
  const re = globToRegExp(g, true);
  if (re.test(p)) return true;
  if (!g.includes("/")) return re.test(p.split("/").pop() ?? "");
  return globToRegExp(`**/${g.replace(/^\/+/, "")}`, true).test(p);
}

const RANK: Record<RuleAction, number> = { allow: 1, ask: 2, deny: 3 };
const strongest = (a: RuleDecision | null, b: RuleDecision | null) => (!a ? b : !b ? a : RANK[b.decision] > RANK[a.decision] ? b : a);

/**
 * What the rules say about a call; null = no rule decides (the approval setting does).
 * deny or ask from any part wins; allow only when every command part (and every path) is allowed by a rule.
 */
export function evaluateRules(rules: PermRule[], call: RuleCall): RuleDecision | null {
  const mine = rules.filter((r) => !r.role || r.role === call.role?.toLowerCase());
  if (!mine.length) return null;
  const decideFor = (test: (r: PermRule) => boolean): RuleDecision | null =>
    mine.filter(test).reduce<RuleDecision | null>((acc, r) => strongest(acc, { decision: r.action, rule: r.source }), null);
  const subjects: (RuleDecision | null)[] = [];
  if (call.kind === "execute") {
    const line = call.command || call.title || "";
    const parts = commandParts(line);
    for (const t of parts.length ? parts : [tokenize(line)]) subjects.push(decideFor((r) => r.kind === "execute" && matchCommand(r.pattern, t)));
  } else if (PATH_KINDS.includes(call.kind) && call.paths?.length) {
    for (const p of call.paths) subjects.push(decideFor((r) => (r.kind === call.kind || (r.kind === "edit" && (call.kind === "delete" || call.kind === "move"))) && matchPath(r.pattern, p)));
  } else {
    subjects.push(decideFor((r) => r.kind === call.kind && globToRegExp(r.pattern, false).test(call.title ?? "")));
  }
  const hard = subjects.reduce<RuleDecision | null>((acc, d) => (d && d.decision !== "allow" ? strongest(acc, d) : acc), null);
  if (hard) return hard;
  return subjects.length && subjects.every((d) => d?.decision === "allow") ? subjects[0] ?? null : null;
}

/** Pull the command line and paths out of an ACP tool call's raw input (field names differ between agent CLIs). */
export function callDetails(rawInput: unknown, locations: unknown): { command: string | null; paths: string[] } {
  const r = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const cmd = r.command ?? r.cmd ?? r.commandLine ?? r.script;
  const command = Array.isArray(cmd) ? cmd.map(String).join(" ") : typeof cmd === "string" ? cmd : null;
  const paths = new Set<string>();
  for (const k of ["path", "file_path", "filePath", "file", "target", "source", "destination", "old_path", "new_path"]) {
    if (typeof r[k] === "string" && r[k]) paths.add(r[k] as string);
  }
  if (Array.isArray(r.paths)) for (const p of r.paths) if (typeof p === "string") paths.add(p);
  if (Array.isArray(locations)) for (const l of locations) if (l && typeof (l as { path?: unknown }).path === "string") paths.add((l as { path: string }).path);
  return { command, paths: [...paths] };
}

export { DEFAULT_RULES } from "@shared/settings";
