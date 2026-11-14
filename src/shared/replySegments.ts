import type { ToolRun } from "./types";

/**
 * Separator to put before a text chunk that resumes after a tool call or a thought. Agents stream short bursts of
 * prose between tool calls ("Let me check the file." … "Found it."); joined as is they read as one wall of text.
 */
export function paragraphBreak(text: string): string {
  if (!text.trim() || text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

export type ReplySegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: ToolRun[] }
  | { kind: "thought"; run: ToolRun };

/**
 * Split an agent reply into what happened in order: prose, the commands it ran, and its reasoning, using each run's
 * `at` (offset into the reply text when it started). Runs without `at` (older replies) stay at the top, as before.
 */
export function replySegments(content: string, tools: ToolRun[] = []): ReplySegment[] {
  const out: ReplySegment[] = [];
  const pushRun = (r: ToolRun) => {
    if (r.kind === "think") { out.push({ kind: "thought", run: r }); return; }
    const last = out[out.length - 1];
    if (last?.kind === "tools") last.tools.push(r);
    else out.push({ kind: "tools", tools: [r] });
  };
  const pushText = (t: string) => { if (t.trim()) out.push({ kind: "text", text: t }); };
  for (const r of tools) if (typeof r.at !== "number") pushRun(r);
  let pos = 0;
  for (const r of tools) {
    if (typeof r.at !== "number") continue;
    const at = Math.min(Math.max(r.at, pos), content.length);
    pushText(content.slice(pos, at));
    pos = at;
    pushRun(r);
  }
  pushText(content.slice(pos));
  return out;
}
