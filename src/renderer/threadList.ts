import type { Message } from "@shared/types";

/**
 * Chat layout rules kept pure so tests can cover them without a DOM:
 * which side a message sits on, and the threads listed in the right-hand Threads panel.
 */

/** Messenger layout: your own messages on the right, agent and system messages on the left (in threads too). */
export function messageSide(m: Pick<Message, "author">): "left" | "right" {
  return m.author === "user" ? "right" : "left";
}

export interface ThreadSummary {
  rootId: string;
  root: Message;
  /** First line of the root message, without Markdown punctuation. */
  preview: string;
  replyCount: number;
  /** When the thread last changed: its latest loaded reply, else the root itself. */
  lastAt: number;
  /** An agent is still writing a reply in it. */
  working: boolean;
}

/** One-line preview of a message for lists. */
export function previewText(content: string, max = 90): string {
  const line = content
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n").map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").trim()).find((l) => l) ?? "";
  const flat = line.replace(/[*_`~]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The threads of a chat in reading order: every main-list message that has replies, plus `extra` roots
 * (a thread opened from "Reply" that has no replies yet). Replies come from the loaded threads when present.
 */
export function chatThreads(roots: Message[], threads: Record<string, Message[] | undefined>, extra: Record<string, boolean> = {}): ThreadSummary[] {
  const out: ThreadSummary[] = [];
  for (const root of roots) {
    if (root.marker || (root.replyCount <= 0 && !extra[root.id])) continue;
    const replies = threads[root.id]?.filter((r) => r.id !== root.id);
    const last = replies?.at(-1);
    out.push({
      rootId: root.id,
      root,
      preview: previewText(root.content) || (root.attachments.length ? root.attachments.map((a) => a.name).join(", ") : "(empty message)"),
      replyCount: Math.max(root.replyCount, replies?.length ?? 0),
      lastAt: last?.createdAt ?? root.createdAt,
      working: !!replies?.some((r) => r.status === "streaming"),
    });
  }
  return out;
}

/**
 * How the Threads panel shows: a full column, or a slim rail. It folds to the rail when you collapsed it, when another
 * side panel (Progress, Artifacts) is open, or when the chat has no threads and you haven't opened it for this chat.
 */
export function threadsPanelMode(opts: { open: boolean; otherPanel: boolean; count: number; openedEmpty: boolean }): "full" | "rail" {
  if (!opts.open || opts.otherPanel) return "rail";
  return opts.count > 0 || opts.openedEmpty ? "full" : "rail";
}
