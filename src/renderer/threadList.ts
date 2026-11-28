import type { Message } from "@shared/types";

/**
 * Chat layout rules kept pure so tests can cover them without a DOM:
 * which side a message sits on, and a one-line preview of a message.
 */

/** Messenger layout: your own messages on the right, agent and system messages on the left  */
export function messageSide(m: Pick<Message, "author">): "left" | "right" {
  return m.author === "user" ? "right" : "left";
}

/** First readable line of a message, without Markdown, cut to `max` characters. */
export function previewText(content: string, max = 90): string {
  const line = content
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n").map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").trim()).find((l) => l) ?? "";
  const flat = line.replace(/[*_`~]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

