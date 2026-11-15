import type { Message } from "@shared/types";

/**
 * Shell-style message history for the composer: Up/Down walk through what you sent in this chat (or thread).
 * Pure helpers so tests cover them without a DOM.
 */

/** Your sent messages, newest first, without repeats in a row or attachment-only placeholders. */
export function sentHistory(messages: Message[] | undefined, parentId: string | null): string[] {
  const out: string[] = [];
  for (const m of [...(messages ?? [])].sort((a, b) => b.seq - a.seq)) {
    if (m.author !== "user" || m.parentId !== parentId) continue;
    const t = m.content.trim();
    if (!t || t === "(see attachments)" || out.at(-1) === t) continue;
    out.push(t);
  }
  return out;
}

/** Up only takes over with the caret on the first line, Down on the last, so multi-line editing still works. */
export function canBrowse(dir: "up" | "down", value: string, selStart: number, selEnd: number): boolean {
  if (selStart !== selEnd) return false;
  return dir === "up" ? !value.slice(0, selStart).includes("\n") : !value.slice(selEnd).includes("\n");
}

/**
 * One step through the history. `index` is null while editing your own draft, else the entry shown (0 = newest).
 * Stepping down past the newest entry returns to the draft (index null).
 */
export function stepHistory(history: string[], index: number | null, dir: "up" | "down"): number | null | undefined {
  if (dir === "up") {
    const next = index === null ? 0 : index + 1;
    return next < history.length ? next : undefined; // undefined: nothing older, leave the box alone
  }
  if (index === null) return undefined;
  return index === 0 ? null : index - 1;
}
