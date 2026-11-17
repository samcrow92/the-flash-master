/**
 * ContextEngine — the token-efficiency core. Pure functions so they are unit-testable.
 *
 *  - estimateTokens: cheap, conservative estimate when a harness reports no usage.
 *  - clipOutput: large outputs become artifacts; agents see head/tail + reference.
 *  - buildTurnPrompt: stable role prefix (cache-friendly) + compact history + new input.
 *  - planCompaction: decide when older turns are replaced by a rolling summary.
 *  - buildBrief / parseResult: delegation hands over briefs, not transcripts, and gets capped results back.
 */
import type { Message, RoleDef, SkillDef } from "@shared/types";

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface Clipped {
  text: string;
  clipped: boolean;
}

export function clipOutput(text: string, maxChars: number, storeArtifact: (full: string) => string): Clipped {
  if (maxChars <= 0 || text.length <= maxChars) return { text, clipped: false };
  const id = storeArtifact(text);
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n…[${omitted} chars omitted — full output stored as artifact ${id}; call fetch_artifact("${id}") only if needed]…\n${text.slice(-tail)}`,
    clipped: true,
  };
}

export interface MentionParse {
  role: string | null;
  text: string;
}

/** "@reviewer please check" → { role: "reviewer", text: "please check" } when role exists. */
export function parseMention(input: string, roles: string[]): MentionParse {
  const m = /^\s*@([a-z][\w-]*)\b\s*/i.exec(input);
  if (m && roles.includes(m[1]!.toLowerCase())) return { role: m[1]!.toLowerCase(), text: input.slice(m[0].length) };
  return { role: null, text: input };
}

export interface SlashParse {
  command: string | null;
  text: string;
}

export function parseSlash(input: string): SlashParse {
  const m = /^\s*\/([a-z][\w-]*)\b\s*/i.exec(input);
  if (!m) return { command: null, text: input };
  return { command: m[1]!.toLowerCase(), text: input.slice(m[0].length) };
}

export const RESULT_CONTRACT = (maxTokens: number) =>
  `When you finish, end your reply with a result block:
<result>
status: done | needs_decision | blocked | failed
question: only for needs_decision / blocked — what you need, the options, and the one you recommend
summary: <= ${maxTokens} tokens — what you did / found, decisions, open questions
findings: bullet list (file:line where relevant)
artifacts: ids of stored artifacts, if any
</result>
Keep large material (logs, full files, long reports) out of the summary: store it with the save_artifact tool and list the id.`;

export interface PromptParts {
  role: RoleDef;
  projectPath: string | null;
  skills: SkillDef[]; // only the skills activated for this turn (on-demand)
  summary: string | null; // rolling summary of older turns
  recent: Pick<Message, "author" | "role" | "content">[];
  input: string;
  brief?: string | null; // for delegated agents
  firstTurn: boolean;
  clean?: boolean;
  houseRules?: string;
  /** "## Relevant memory" block for this turn (empty = none). */
  memory?: string;
}

/**
 * Build the text sent for a turn. Harness sessions keep their own history, so after the first turn we only
 * send the new input (+ any activated skill). On the first turn of a (re)started session we send the stable
 * prefix and a compact history instead of the full transcript.
 */
export function buildTurnPrompt(p: PromptParts): string {
  const out: string[] = [];
  if (p.firstTurn) {
    out.push(rolePrefix(p.role, p.projectPath, { clean: p.clean, houseRules: p.houseRules }));
    if (p.brief) out.push(`## Brief\n${p.brief}`);
    if (p.summary) out.push(`## Conversation so far (summary)\n${p.summary}`);
    if (p.recent.length) {
      out.push("## Recent turns\n" + p.recent.map((m) => `${m.author === "user" ? "User" : (m.role ?? "Agent")}: ${m.content}`).join("\n\n"));
    }
  }
  if (p.memory?.trim()) out.push(p.memory.trim());
  for (const s of p.skills) out.push(`## Workflow: ${s.name} (activated on demand)\n${s.body}`);
  out.push(p.firstTurn ? `## Request\n${p.input}` : p.input);
  return out.join("\n\n");
}

/** Replies are read in a chat: one idea per paragraph, not one long block. */
export const REPLY_STYLE = "Reply style: the user reads your replies in a chat. Write short paragraphs (one idea each, two to four sentences) separated by blank lines. "
  + "Use a bullet list for steps or several findings, a heading when a reply has distinct parts, and code blocks for code and commands. "
  + "Before and after tool calls, say briefly what you are checking and what you found, each as its own paragraph.";

/**
 * pstack's unslop skill as a standing writing rule. It covers what the agent writes through tools too (the user asked for
 * it "for all tool interactions"), but never code, quotes or output passed along verbatim.
 */
export function unslopRules(skill: Pick<SkillDef, "body"> | undefined): string {
  if (!skill?.body.trim()) return "";
  return "## Writing style (unslop)\nApply these rules to everything you write: replies, results, briefs for other agents, and text you write through tools "
    + "(commit messages, PR descriptions, issue and review comments, docs, reports). Leave code, identifiers, quoted text and tool output you pass along verbatim as they are.\n\n"
    + skill.body.trim();
}

/** Byte-stable prefix: never put timestamps or counters here, so provider prompt caches stay warm. */
export function rolePrefix(role: RoleDef, projectPath: string | null, o: { clean?: boolean; houseRules?: string } = {}): string {
  return [
    `# Role: ${role.title}`,
    o.clean ? "You are running inside TheFlashMaster. These instructions are your complete operating instructions and take precedence over any other instruction files, rules or personas you may have loaded." : "",
    role.prompt.trim(),
    o.houseRules?.trim() ? `## Team rules\n${o.houseRules.trim()}` : "",
    projectPath ? `Project root: ${projectPath} — work only inside it.` : "No project folder is attached to this chat.",
    "Token discipline: read only what you need (search before reading, read ranges not whole files), never paste large files back, summarise tool output.",
    "Progress: for multi-step work, publish a short step plan with report_progress and update it as steps complete.",
    REPLY_STYLE,
    RESULT_CONTRACT(role.maxResultTokens),
  ].filter(Boolean).join("\n\n");
}

export interface CompactionPlan {
  compact: boolean;
  summarise: Pick<Message, "author" | "role" | "content">[];
  keep: Pick<Message, "author" | "role" | "content">[];
}

export function planCompaction<T extends Pick<Message, "author" | "role" | "content">>(history: T[], thresholdTokens: number,
  keepRecent: number): CompactionPlan {
  const total = history.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (thresholdTokens <= 0 || total <= thresholdTokens || history.length <= keepRecent) {
    return { compact: false, summarise: [], keep: history };
  }
  return { compact: true, summarise: history.slice(0, history.length - keepRecent), keep: history.slice(-keepRecent) };
}

/** Deterministic extractive summary — no model call needed, so compaction itself costs zero tokens. */
export function extractiveSummary(prev: string | null, msgs: Pick<Message, "author" | "role" | "content">[], maxChars = 2400): string {
  const lines = msgs.map((m) => {
    const who = m.author === "user" ? "User" : (m.role ?? "Agent");
    const result = parseResult(m.content);
    const body = result.summary ?? firstSentences(m.content, 240);
    return `- ${who}: ${body.replace(/\s+/g, " ").trim()}`;
  });
  const merged = [prev, ...lines].filter(Boolean).join("\n");
  return merged.length > maxChars ? "…" + merged.slice(-maxChars) : merged;
}

function firstSentences(text: string, max: number): string {
  const t = text.replace(/```[\s\S]*?```/g, "[code]").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

/** How an agent says its turn ended. needs_decision and blocked are surfaced to the user as well as the delegating agent. */
export type ResultStatus = "done" | "needs_decision" | "blocked" | "failed";
const RESULT_STATUSES: ResultStatus[] = ["done", "needs_decision", "blocked", "failed"];

export interface ParsedResult {
  /** null when the reply has no result block; "done" when the block has no (valid) status line. */
  status: ResultStatus | null;
  question: string | null;
  summary: string | null;
  findings: string[];
  artifacts: string[];
}

export function parseResult(text: string): ParsedResult {
  const m = /<result>([\s\S]*?)(?:<\/result>|$)/i.exec(text);
  if (!m) return { status: null, question: null, summary: null, findings: [], artifacts: [] };
  const block = m[1]!;
  const raw = /^\s*status:\s*([\w-]+)/im.exec(block)?.[1]?.toLowerCase().replace(/-/g, "_") ?? "";
  const status = (RESULT_STATUSES as string[]).includes(raw) ? (raw as ResultStatus) : "done";
  const question = /^\s*question:\s*([\s\S]*?)(?:\n\s*(?:summary|findings|artifacts):|$)/im.exec(block)?.[1]?.trim() || null;
  const summary = /summary:\s*([\s\S]*?)(?:\n\s*(?:findings|artifacts):|$)/i.exec(block)?.[1]?.trim() || null;
  const findingsBlock = /findings:\s*([\s\S]*?)(?:\n\s*artifacts:|$)/i.exec(block)?.[1] ?? "";
  const findings = findingsBlock.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  const artifacts = (/artifacts:\s*(.*)/i.exec(block)?.[1] ?? "").split(/[,\s]+/).map((s) => s.trim()).filter((s) => s && s !== "none" && s !== "-");
  return { status, question, summary, findings, artifacts };
}

/** Compact result that goes back to a delegating agent: summary + findings, capped. */
export function resultForParent(text: string, maxTokens: number): string {
  const r = parseResult(text);
  const body = r.summary
    ? [r.status && r.status !== "done" ? `status: ${r.status}` : "", r.question ? `question: ${r.question}` : "", `summary: ${r.summary}`, r.findings.length ? "findings:\n" + r.findings.map((f) => `- ${f}`).join("\n") : "", r.artifacts.length ? `artifacts: ${r.artifacts.join(", ")}` : ""].filter(Boolean).join("\n")
    : text;
  const maxChars = maxTokens * 4;
  return body.length > maxChars ? body.slice(0, maxChars) + "\n…[truncated to result budget]" : body;
}

export function buildBrief(i: { goal: string; context?: string; files?: string[]; acceptance?: string; parentRole?: string }): string {
  return [
    `Goal: ${i.goal.trim()}`,
    i.context ? `Context: ${i.context.trim()}` : "",
    i.files?.length ? `Relevant files: ${i.files.join(", ")}` : "",
    i.acceptance ? `Done when: ${i.acceptance.trim()}` : "",
    i.parentRole ? `Delegated by: ${i.parentRole}. Report back with the result block only — they do not see your working.` : "",
  ].filter(Boolean).join("\n");
}

export type BudgetState = "ok" | "warn" | "exceeded";

export function budgetState(used: number, limit: number, warnPct: number): BudgetState {
  if (limit <= 0) return "ok";
  if (used >= limit) return "exceeded";
  if (used >= (limit * warnPct) / 100) return "warn";
  return "ok";
}

export interface TextDelegation { role: string; harness?: string; folder?: string; model?: string; args?: string; goal: string }

/** Instructions for a coordinator whose `delegate` tool didn't load (MCP blocked by policy, Pi without MCP…). */
export const TEXT_DELEGATION_RULES = `## Delegation (text mode)
In this session you delegate in plain text, not with a \`delegate\` tool. Write one block per sub-task,
starting at the beginning of a line:
DELEGATE <role>: <brief: goal, the key facts, relevant files, what "done" means>
DELEGATE <role>@<harness>: <brief>   (harness = copilot, opencode, cursor, claude, pi or duo, only when the user asked for one)
DELEGATE <role>@<harness> in "<folder>": <brief>   (run it in that folder instead of the project, e.g. GitLab Duo, which only runs in GitLab repos)
DELEGATE <role>@<harness> model "<model>": <brief>   (run it on that model; for Pi write provider/model, e.g. DELEGATE scout@pi model "qwen-local-8800/qwen3.8:27b": …)
DELEGATE <role>@<harness> args "<extra launch arguments>": <brief>   (rarely needed, e.g. args "--thinking high" for Pi)
in, model and args can be combined in any order. Always use model "…" when the user or brief names a model or provider:
a model named only in the brief text is not applied.
A brief may continue on the following lines until a blank line.
To create a new agent first (when no existing specialist fits), write a block before the DELEGATE lines:
AGENT <name>[@<harness>]: <one-line description>
<its complete instructions: role, how it works, what it returns; several lines and blank lines are fine>
END
Then delegate to it by name. Then end your reply. TheFlashMaster runs those specialists
(a few at a time; more wait for a free one) and sends you their results in the next message; integrate them, or delegate
follow-ups the same way. Keep the team small: one DELEGATE per area of work with a combined brief, not one per file.
Don't do the work yourself, and don't call tools to do it.`;

/** DELEGATE lines written by a coordinator in text mode (outside code fences). */
export function parseTextDelegations(text: string): TextDelegation[] {
  const out: TextDelegation[] = [];
  let cur: TextDelegation | null = null;
  let fence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { fence = !fence; cur = null; continue; }
    if (fence) continue;
    const m = /^\s*(?:[-*]\s+)?(?:\*\*)?DELEGATE(?:\*\*)?\s+`?([A-Za-z][\w-]*)(?:@(copilot|opencode|cursor|claude|pi|duo))?`?((?:\s+(?:in|model|args)\s+(?:"[^"]*"|`[^`]*`))*)\s*:\s*(.*)$/.exec(raw);
    if (m) {
      const opt: Record<string, string> = {};
      for (const o of m[3]!.matchAll(/(in|model|args)\s+(?:"([^"]*)"|`([^`]*)`)/g)) { const v = (o[2] ?? o[3] ?? "").trim(); if (v) opt[o[1]!] = v; }
      cur = { role: m[1]!.toLowerCase(), ...(m[2] ? { harness: m[2] } : {}), ...(opt.in ? { folder: opt.in } : {}),
        ...(opt.model ? { model: opt.model } : {}), ...(opt.args ? { args: opt.args } : {}), goal: m[4]!.trim() };
      out.push(cur);
      continue;
    }
    if (/^\s*(?:\*\*)?(?:AGENT|END)\b/.test(raw)) { cur = null; continue; }
    if (!raw.trim() || /^<\/?result>/.test(raw.trim())) { cur = null; continue; }
    if (cur) cur.goal = `${cur.goal}\n${raw.trim()}`.trim();
  }
  return out.filter((d) => d.goal);
}

export interface TextAgent { name: string; harness?: string; description: string; instructions: string }

/** AGENT … END blocks: agents a text-mode coordinator defines before delegating to them. */
export function parseTextAgents(text: string): TextAgent[] {
  const out: TextAgent[] = [];
  let cur: TextAgent | null = null;
  let fence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!cur && /^\s*```/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^\s*(?:\*\*)?AGENT(?:\*\*)?\s+`?([A-Za-z][\w-]*)(?:@(copilot|opencode|cursor|claude|pi|duo))?`?\s*:\s*(.*)$/.exec(raw);
    if (m) { cur = { name: m[1]!.toLowerCase(), ...(m[2] ? { harness: m[2] } : {}), description: m[3]!.trim(), instructions: "" }; out.push(cur); continue; }
    if (!cur) continue;
    if (/^\s*(?:\*\*)?(END|DELEGATE)\b/.test(raw) || /^\s*<result>/.test(raw)) { cur = null; continue; }
    cur.instructions += `${raw}\n`;
  }
  return out.map((a) => ({ ...a, instructions: a.instructions.trim() })).filter((a) => a.instructions);
}

export interface ToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }
export interface TextToolCall { name: string; args: Record<string, unknown>; error?: string }

/**
 * TheFlashMaster's own tools for an agent that may not have them as real tools (Pi has no MCP; MCP can be blocked by
 * policy in Copilot/OpenCode). Compact signatures only, to keep the prompt small.
 */
export function textToolRules(tools: ToolInfo[]): string {
  const sig = (t: ToolInfo) => {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const req = new Set(((t.inputSchema as { required?: string[] }).required) ?? []);
    const args = Object.keys(props).map((k) => (req.has(k) ? k : `${k}?`)).join(", ");
    return `- ${t.name}(${args}): ${t.description.split(/(?<=\.)\s/)[0]!.slice(0, 160)}`;
  };
  return `## TheFlashMaster tools (text mode)
If these TheFlashMaster tools are not available to you as real tools, call them in plain text instead: one call per line,
at the start of the line, with JSON arguments:
TOOL <name> {"arg": "value"}
Then end your reply. TheFlashMaster runs the calls and sends the results in the next message. Use the real tools when you have them.
${tools.map(sig).join("\n")}`;
}

/** TOOL lines: `TOOL name {json}`; the JSON may continue over the next lines. */
export function parseTextToolCalls(text: string, known?: Set<string>): TextToolCall[] {
  return scanTextToolCalls(text, known).map(({ call }) => call);
}

/**
 * The reply text without the TOOL lines that were parsed into calls, so each call shows once (in the tool-call panel)
 * and not again in the prose. Lines whose arguments failed to parse stay, since no panel entry shows them.
 */
export function stripTextToolCalls(text: string, known?: Set<string>): string {
  const drop = new Set<number>();
  for (const { call, from, to } of scanTextToolCalls(text, known)) if (!call.error) for (let i = from; i <= to; i++) drop.add(i);
  if (!drop.size) return text;
  return text.split(/\r?\n/).filter((_, i) => !drop.has(i)).join("\n")
    .replace(/^[ \t]*```[\w-]*[ \t]*\n(?:[ \t]*\n)*[ \t]*```[ \t]*$/gm, "") // a fence that held only calls
    .replace(/\n{3,}/g, "\n\n").trim();
}

function scanTextToolCalls(text: string, known?: Set<string>): { call: TextToolCall; from: number; to: number }[] {
  const out: { call: TextToolCall; from: number; to: number }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:[-*]\s+)?`?TOOL`?\s+`?([a-z][a-z0-9_]*)`?\s*(.*)$/.exec(lines[i]!);
    if (!m || (known && !known.has(m[1]!))) continue;
    const from = i;
    let json = m[2]!.trim().replace(/`+$/, "");
    if (!json) { out.push({ call: { name: m[1]!, args: {} }, from, to: i }); continue; }
    let parsed: unknown;
    for (let j = i; j < Math.min(lines.length, i + 60); j++) {
      if (j > i) json += `\n${lines[j]}`;
      try { parsed = JSON.parse(json); i = j; break; } catch { /* keep reading */ }
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push({ call: { name: m[1]!, args: parsed as Record<string, unknown> }, from, to: i });
    else out.push({ call: { name: m[1]!, args: {}, error: "arguments are not a JSON object" }, from, to: from });
  }
  return out;
}
