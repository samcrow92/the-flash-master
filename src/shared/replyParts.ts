/**
 * Makes a coordinator's reply easy to scan: the machine-facing parts of the text (text-mode DELEGATE / AGENT blocks,
 * the <result> block) become compact cards, and a trailing "Details" section folds away. Nothing is dropped: every
 * brief, finding and detail is one click away.
 */

import { briefBody } from "./briefs";

export interface DelegationPart { role: string; harness: string | null; brief: string }
export interface ResultPart { status: string; question: string | null; summary: string | null; findings: string[]; artifacts: string[] }

export type ReplyPart =
  | { kind: "md"; text: string }
  | { kind: "delegations"; items: DelegationPart[] }
  | { kind: "agent"; name: string; description: string; instructions: string }
  | { kind: "result"; result: ResultPart }
  | { kind: "details"; title: string; text: string };

// Same shapes the app carries out (src/main/context.ts), also when written as a list item or in bold.
const DELEGATE = /^\s*(?:[-*]\s+)?(?:\*\*)?DELEGATE(?:\*\*)?\s+([\w.-]+)(?:@([\w-]+))?([^:\n]*):\s*(.*)$/;
const AGENT = /^\s*(?:[-*]\s+)?(?:\*\*)?AGENT(?:\*\*)?\s+([\w.-]+)(?:@[\w-]+)?\s*:\s*(.*)$/;
const DETAILS = /^\s*#{1,4}\s*(?:\*\*)?(Details|More details|Full details)(?:\*\*)?\s*:?\s*$/i;

export function parseResultBlock(block: string): ResultPart {
  const raw = /^\s*status:\s*([\w-]+)/im.exec(block)?.[1]?.toLowerCase().replace(/-/g, "_") ?? "done";
  const question = /^\s*question:\s*([\s\S]*?)(?:\n\s*(?:options|summary|findings|artifacts):|$)/im.exec(block)?.[1]?.trim() || null;
  const summary = /summary:\s*([\s\S]*?)(?:\n\s*(?:findings|artifacts):|$)/i.exec(block)?.[1]?.trim() || null;
  const findingsBlock = /findings:\s*([\s\S]*?)(?:\n\s*artifacts:|$)/i.exec(block)?.[1] ?? "";
  const findings = findingsBlock.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  const artifacts = (/artifacts:\s*(.*)/i.exec(block)?.[1] ?? "").split(/[,\s]+/).map((s) => s.trim()).filter((s) => s && s !== "none" && s !== "-");
  return { status: raw, question, summary, findings, artifacts };
}

export function replyParts(text: string): ReplyPart[] {
  const out: ReplyPart[] = [];
  const { main, details } = splitDetails(text);
  const re = /<result>([\s\S]*?)(?:<\/result>|$)/gi;
  let pos = 0;
  for (const m of main.matchAll(re)) {
    lineParts(main.slice(pos, m.index), out);
    out.push({ kind: "result", result: parseResultBlock(m[1]!) });
    pos = m.index! + m[0].length;
  }
  lineParts(main.slice(pos), out);
  if (details) out.push(details);
  return out;
}

/** A "## Details" heading (outside code) starts the folded part, up to the end of the reply. */
function splitDetails(text: string): { main: string; details: Extract<ReplyPart, { kind: "details" }> | null } {
  const lines = text.split(/\r?\n/);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) fence = !fence;
    const h = !fence && DETAILS.exec(lines[i]!);
    const rest = h ? lines.slice(i + 1).join("\n").trim() : "";
    if (h && rest) return { main: lines.slice(0, i).join("\n"), details: { kind: "details", title: h[1]!, text: rest } };
  }
  return { main: text, details: null };
}

/** Markdown, with text-mode DELEGATE groups and AGENT … END blocks taken out as cards. */
function lineParts(text: string, out: ReplyPart[]): void {
  let md: string[] = [];
  const flush = () => { const t = md.join("\n"); if (t.trim()) out.push({ kind: "md", text: t }); md = []; };
  const lines = text.split(/\r?\n/);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) { fence = !fence; md.push(line); continue; }
    if (fence) { md.push(line); continue; }
    const d = DELEGATE.exec(line);
    if (d) {
      const { body, next } = briefBody(lines, i);
      i = next - 1;
      const item = { role: d[1]!, harness: d[2] ?? null, brief: [d[4]!.trim(), ...body].join("\n").trim() };
      const last = out[out.length - 1];
      // Blank lines between DELEGATE blocks keep them in one group.
      if (!md.join("").trim() && last?.kind === "delegations") { md = []; last.items.push(item); continue; }
      flush();
      out.push({ kind: "delegations", items: [item] });
      continue;
    }
    const a = AGENT.exec(line);
    if (a) {
      let j = i + 1;
      while (j < lines.length && !/^\s*(?:\*\*)?END(?:\*\*)?\s*$/.test(lines[j]!)) j++;
      if (j < lines.length) {
        flush();
        out.push({ kind: "agent", name: a[1]!, description: a[2]!.trim(), instructions: lines.slice(i + 1, j).join("\n").trim() });
        i = j;
        continue;
      }
    }
    md.push(line);
  }
  flush();
}

/** First sentence (or line) of a brief, for the one-line card. */
export function briefHeadline(brief: string, max = 140): string {
  const first = brief.split("\n")[0]!.trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(first)?.[1] ?? first;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** A short one-line system notice ("↪ Delegating: …") shows as a slim line in the chat instead of a full message card. */
export function isNoticeLine(m: { author: string; content: string; tools?: unknown[]; reactions?: string[]; ask?: unknown }): boolean {
  return m.author === "system" && !m.ask && !m.content.trim().includes("\n") && m.content.length <= 240 && !m.tools?.length && !m.reactions?.length;
}
