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
}

/**
 * Build the text sent for a turn. Harness sessions keep their own history, so after the first turn we only
 * send the new input (+ any activated skill). On the first turn of a (re)started session we send the stable
 * prefix and a compact history instead of the full transcript.
 */
export function buildTurnPrompt(p: PromptParts): string {
  const out: string[] = [];
  if (p.firstTurn) {
    out.push(rolePrefix(p.role, p.projectPath));
    if (p.brief) out.push(`## Brief\n${p.brief}`);
    if (p.summary) out.push(`## Conversation so far (summary)\n${p.summary}`);
    if (p.recent.length) {
      out.push("## Recent turns\n" + p.recent.map((m) => `${m.author === "user" ? "User" : (m.role ?? "Agent")}: ${m.content}`).join("\n\n"));
    }
  }
  for (const s of p.skills) out.push(`## Workflow: ${s.name} (activated on demand)\n${s.body}`);
  out.push(p.firstTurn ? `## Request\n${p.input}` : p.input);
  return out.join("\n\n");
}

/** Byte-stable prefix: never put timestamps or counters here, so provider prompt caches stay warm. */
export function rolePrefix(role: RoleDef, projectPath: string | null): string {
  return [
    `# Role: ${role.title}`,
    role.prompt.trim(),
    projectPath ? `Project root: ${projectPath} — work only inside it.` : "No project folder is attached to this chat.",
    "Token discipline: read only what you need (search before reading, read ranges not whole files), never paste large files back, summarise tool output.",
    "Progress: for multi-step work, publish a short step plan with report_progress and update it as steps complete.",
    RESULT_CONTRACT(role.maxResultTokens),
  ].join("\n\n");
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

export interface ParsedResult {
  summary: string | null;
  findings: string[];
  artifacts: string[];
}

export function parseResult(text: string): ParsedResult {
  const m = /<result>([\s\S]*?)(?:<\/result>|$)/i.exec(text);
  if (!m) return { summary: null, findings: [], artifacts: [] };
  const block = m[1]!;
  const summary = /summary:\s*([\s\S]*?)(?:\n\s*(?:findings|artifacts):|$)/i.exec(block)?.[1]?.trim() || null;
  const findingsBlock = /findings:\s*([\s\S]*?)(?:\n\s*artifacts:|$)/i.exec(block)?.[1] ?? "";
  const findings = findingsBlock.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  const artifacts = (/artifacts:\s*(.*)/i.exec(block)?.[1] ?? "").split(/[,\s]+/).map((s) => s.trim()).filter((s) => s && s !== "none" && s !== "-");
  return { summary, findings, artifacts };
}

/** Compact result that goes back to a delegating agent: summary + findings, capped. */
export function resultForParent(text: string, maxTokens: number): string {
  const r = parseResult(text);
  const body = r.summary
    ? [`summary: ${r.summary}`, r.findings.length ? "findings:\n" + r.findings.map((f) => `- ${f}`).join("\n") : "", r.artifacts.length ? `artifacts: ${r.artifacts.join(", ")}` : ""].filter(Boolean).join("\n")
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
