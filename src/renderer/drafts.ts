import type { Attachment } from "@shared/types";

/**
 * Per-chat and per-thread composer drafts. Each composer reads and writes the draft under its own key, so text
 * typed in one chat is never carried into another and survives switching chats, closing a thread or a restart.
 * Text is kept in localStorage (wrapped: storage can be unavailable); attachments only for this session.
 */
export interface Draft { text: string; attachments: Attachment[] }

const STORAGE_KEY = "drafts.v1";
/** Oldest drafts are dropped past this many, so abandoned chats can't grow storage forever. */
export const MAX_DRAFTS = 200;

export const draftKey = (chatId: string, parentId: string | null) => (parentId ? `${chatId}/${parentId}` : chatId);

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

const defaultStorage = (): StorageLike | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};

export function createDraftStore(storage: StorageLike | null = defaultStorage()) {
  let texts: Record<string, string> = {};
  // Re-read before each use: a pop-out thread window shares the storage, so neither window may overwrite the other's drafts.
  const load = () => {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw != null) { const v = JSON.parse(raw); texts = v && typeof v === "object" ? v : {}; }
    } catch { /* keep what we have */ }
  };
  load();
  const atts = new Map<string, Attachment[]>();
  const persist = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(texts)); } catch { /* storage full or unavailable */ } };

  return {
    get(key: string): Draft {
      load();
      return { text: texts[key] ?? "", attachments: atts.get(key) ?? [] };
    },
    set(key: string, d: Partial<Draft>): void {
      if (d.attachments !== undefined) {
        if (d.attachments.length) atts.set(key, d.attachments); else atts.delete(key);
      }
      if (d.text === undefined) return;
      load();
      if (d.text === (texts[key] ?? "")) return;
      // Re-insert so key order is "least recently edited first", which is what the cap trims.
      const { [key]: _old, ...rest } = texts;
      texts = d.text ? { ...rest, [key]: d.text } : rest;
      const keys = Object.keys(texts);
      if (keys.length > MAX_DRAFTS) for (const k of keys.slice(0, keys.length - MAX_DRAFTS)) delete texts[k];
      persist();
    },
    clear(key: string): void {
      this.set(key, { text: "", attachments: [] });
    },
    /** Drafts with text, for "has a draft" hints. */
    keys(): string[] { load(); return Object.keys(texts); },
  };
}

export const drafts = createDraftStore();
