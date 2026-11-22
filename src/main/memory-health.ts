/**
 * Memory hygiene: near-duplicates to merge, memories that may be out of date (a file they mention is gone, or changed
 * since the commit they were saved at), and memories nobody uses. Pure: the caller says which paths exist and changed.
 */
import type { Memory, MemoryHealth } from "@shared/types";
import { cosine, vectorize } from "./memory";

export const MERGE_AT = 0.8;
export const UNUSED_DAYS = 90;
const DAY = 86_400_000;

const EXT = "c|h|cc|cpp|hpp|cs|py|ts|tsx|js|jsx|mjs|json|ya?ml|toml|md|arxml|dbc|cdd|a2l|ldf|xml|can|cin|capl|sh|ps1|bat|cmake|mk|ini|cfg|sql|rs|go|java|kt|swift|m|html|css";
const PATH_RE = new RegExp(`(?:^|[\\s\`'"(\\[])((?:[\\w.-]+/)*[\\w.-]+\\.(?:${EXT}))(?=$|[\\s\`'"),.:;\\]])`, "gi");

/** File paths a memory mentions (relative, forward slashes; URLs and absolute paths are left out). */
export function mentionedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1]!.replace(/\\/g, "/");
    if (/^[a-z]+:\/\//i.test(p) || p.startsWith("/") || /^\d+(\.\d+)+$/.test(p)) continue;
    const prev = text.slice(Math.max(0, (m.index ?? 0) - 8), (m.index ?? 0) + 1);
    if (/:\/\/\S*$/.test(prev)) continue;
    out.add(p.replace(/^\.\//, ""));
  }
  return [...out];
}

/** Groups of near-duplicate memories in the same place (scope, project, chat); knowledge base entries are left alone. */
export function duplicateGroups(ms: Memory[], at = MERGE_AT): { ids: number[]; similarity: number }[] {
  const plain = ms.filter((m) => !m.kbSlug);
  const vec = new Map(plain.map((m) => [m.id, vectorize(m.content)]));
  const seen = new Set<number>();
  const groups: { ids: number[]; similarity: number }[] = [];
  for (const a of plain) {
    if (seen.has(a.id)) continue;
    let min = 1;
    const ids = [a.id];
    for (const b of plain) {
      if (b.id === a.id || seen.has(b.id) || b.scope !== a.scope || b.projectId !== a.projectId || b.chatId !== a.chatId) continue;
      const sim = cosine(vec.get(a.id)!, vec.get(b.id)!);
      if (sim >= at) { ids.push(b.id); min = Math.min(min, sim); }
    }
    if (ids.length > 1) {
      ids.forEach((i) => seen.add(i));
      // The one worth keeping first (the card's "Merge into the first").
      const by = new Map(plain.map((m) => [m.id, m]));
      groups.push({ ids: ids.map((i) => by.get(i)!).sort(keeperOrder).map((m) => m.id), similarity: Math.round(min * 100) / 100 });
    }
  }
  return groups;
}

export function memoryHealth(ms: Memory[], o: { exists: (path: string) => boolean | null; changedSince: (commit: string, paths: string[]) => string[] | null;
  now?: number; unusedDays?: number }): MemoryHealth {
  const now = o.now ?? Date.now();
  const stale: MemoryHealth["stale"] = [];
  for (const m of ms) {
    if (m.scope === "user") continue; // about the person, not the code
    const paths = mentionedPaths(m.content);
    if (!paths.length) continue;
    const gone = paths.filter((p) => o.exists(p) === false);
    if (gone.length) { stale.push({ id: m.id, reason: `mentions ${gone.slice(0, 3).join(", ")}, which no longer exist${gone.length === 1 ? "s" : ""}` }); continue; }
    if (m.commit) {
      const changed = o.changedSince(m.commit, paths) ?? [];
      if (changed.length) stale.push({ id: m.id, reason: `${changed.slice(0, 3).join(", ")} changed since it was saved (${m.commit.slice(0, 7)})` });
    }
  }
  const cutoff = now - (o.unusedDays ?? UNUSED_DAYS) * DAY;
  const unused = ms.filter((m) => !m.pinned && !m.kbSlug && m.importance <= 2 && m.lastAccessedAt < cutoff && m.updatedAt < cutoff).map((m) => m.id);
  return { duplicates: duplicateGroups(ms), stale, unused };
}

/** Which memory of a duplicate group to keep: pinned, then most important, most used, newest. */
export function pickKeeper(ms: Memory[]): Memory {
  return [...ms].sort(keeperOrder)[0]!;
}

function keeperOrder(a: Memory, b: Memory): number {
  return Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.accessCount - a.accessCount || b.updatedAt - a.updatedAt;
}
