import type { Chat } from "@shared/types";

/**
 * App-wide keyboard shortcuts and command palette ranking (pure, so tests can cover them without a DOM).
 * "Mod" is Cmd on macOS and Ctrl on Windows/Linux.
 */
export type ShortcutId = "palette" | "newChat" | "settings" | "focusComposer" | "prevChat" | "nextChat" | "stop" | "search";

export const SHORTCUTS: Record<ShortcutId, { keys: string; label: string }> = {
  palette: { keys: "Mod+K", label: "Command palette" },
  newChat: { keys: "Mod+N", label: "New chat" },
  settings: { keys: "Mod+,", label: "Settings" },
  focusComposer: { keys: "Mod+L", label: "Focus the message box" },
  prevChat: { keys: "Alt+↑", label: "Previous chat" },
  nextChat: { keys: "Alt+↓", label: "Next chat" },
  stop: { keys: "Esc", label: "Stop agents in this chat" },
  search: { keys: "Mod+Shift+F", label: "Search all chats" },
};

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

export function matchShortcut(e: KeyLike, mac: boolean): ShortcutId | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey && !e.shiftKey) {
    if (key === "k") return "palette";
    if (key === "n") return "newChat";
    if (key === ",") return "settings";
    if (key === "l") return "focusComposer";
  }
  if (mod && !e.altKey && e.shiftKey && key === "f") return "search";
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (key === "ArrowUp") return "prevChat";
    if (key === "ArrowDown") return "nextChat";
  }
  if (key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return "stop";
  return null;
}

/** Shortcut text for this platform, e.g. "Ctrl+K" or "⌘K". */
export function shortcutLabel(keys: string, mac: boolean): string {
  if (!mac) return keys.replace("Mod", "Ctrl");
  return keys.replace("Mod+", "⌘").replace("Alt+", "⌥").replace("Shift+", "⇧");
}

/** Chats in the order the sidebar shows them: master chat, then each project's open chats (pinned first). */
export function chatOrder(masterChatId: string | null, projectIds: string[], chats: Record<string, Chat[]>): string[] {
  const byPinned = (a: Chat, b: Chat) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt;
  const ids = masterChatId ? [masterChatId] : [];
  for (const p of projectIds) ids.push(...(chats[p] ?? []).filter((c) => !c.archived).sort(byPinned).map((c) => c.id));
  return ids;
}

/** The chat `step` places away from `current` in sidebar order, wrapping around. */
export function stepChat(order: string[], current: string | null, step: 1 | -1): string | null {
  if (!order.length) return null;
  const i = current ? order.indexOf(current) : -1;
  if (i < 0) return order[step === 1 ? 0 : order.length - 1]!;
  return order[(i + step + order.length) % order.length]!;
}

export interface Command { id: string; label: string; group: string; keywords?: string; hint?: string }

/**
 * Fuzzy score of `query` against a label: a prefix beats a word start, which beats a substring, which beats
 * letters in order (fewer gaps first). Keywords count at a lower weight. 0 = no match.
 */
export function scoreCommand(c: Pick<Command, "label" | "keywords">, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const label = c.label.toLowerCase();
  const at = label.indexOf(q);
  if (at === 0) return 100;
  if (at > 0) return /[\s\-_/·.]/.test(label[at - 1]!) ? 80 : 60;
  if (c.keywords?.toLowerCase().includes(q)) return 45;
  // Every query word appears somewhere: "set mcp" → "Settings · MCP servers".
  const words = q.split(/\s+/);
  const hay = `${label} ${c.keywords?.toLowerCase() ?? ""}`;
  if (words.length > 1 && words.every((w) => hay.includes(w))) return 40;
  let pos = -1, gaps = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    const next = label.indexOf(ch, pos + 1);
    if (next < 0) return 0;
    if (pos >= 0 && next > pos + 1) gaps++;
    pos = next;
  }
  return Math.max(5, 30 - gaps * 3);
}

/** Matching commands, best first; ties keep the given order (so callers decide what comes first). */
export function rankCommands<T extends Command>(items: T[], query: string, limit = 50): T[] {
  return items
    .map((c, i) => ({ c, i, s: scoreCommand(c, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
