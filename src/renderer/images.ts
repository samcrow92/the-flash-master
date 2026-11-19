/**
 * Images shown inline in chats. Local pictures (agent screenshots, `![shot](C:\out\shot.png)`, a bare path to a .png)
 * are read by the main process (api.readImage, which applies the same rules as opening a link) and come back as data
 * URLs, because the page only loads `data:` images. Results are cached so a streaming reply doesn't re-read them.
 */

/** `thumb`: src is a small preview; the viewer reads the full picture from `path`. */
export interface ViewImage { src: string; name?: string; path?: string; chatId?: string | null; thumb?: boolean }

const MAX_CACHE = 48;
const cache = new Map<string, string>();
// Misses are retried after a while: an agent often names a screenshot before it has finished writing it.
const failed = new Map<string, { detail: string; at: number }>();
const RETRY_MS = 8000;
const pending = new Map<string, Promise<{ ok: boolean; src?: string; detail?: string }>>();
const key = (target: string, chatId: string | null | undefined) => `${chatId ?? ""}|${target}`;

/** A cached data URL for this image, if it was already loaded (used while rendering so previews don't flicker). */
export function cachedImage(target: string, chatId?: string | null): string | undefined {
  return cache.get(key(target, chatId)) ?? cache.get(key(target, null));
}

/** The chat an element belongs to (relative image paths resolve against its project). */
export function chatOf(el: Element | null): string | null {
  return el?.closest<HTMLElement>("[data-chat]")?.dataset.chat ?? null;
}

export function loadImage(target: string, chatId: string | null): Promise<{ ok: boolean; src?: string; detail?: string }> {
  const k = key(target, chatId);
  const hit = cache.get(k);
  if (hit) return Promise.resolve({ ok: true, src: hit });
  const bad = failed.get(k);
  if (bad && Date.now() - bad.at < RETRY_MS) return Promise.resolve({ ok: false, detail: bad.detail });
  const running = pending.get(k);
  if (running) return running;
  const p = (async () => {
    try {
      // Loaded lazily so Markdown stays renderable outside the app (tests, static rendering).
      const { api, useStore } = await import("./store");
      const st = useStore.getState();
      const r = await api().readImage(target, chatId ?? (st.view.kind === "chat" ? st.view.chatId : null));
      if (!r.ok) { failed.set(k, { detail: r.detail, at: Date.now() }); return { ok: false, detail: r.detail }; }
      failed.delete(k);
      cache.set(k, r.dataUrl);
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
      return { ok: true, src: r.dataUrl };
    } catch (e) {
      return { ok: false, detail: String((e as Error)?.message ?? e) };
    } finally { pending.delete(k); }
  })();
  pending.set(k, p);
  return p;
}

/** Fill in the `<img data-img>` previews of a rendered Markdown block. */
export function hydrateImages(root: HTMLElement): void {
  const chatId = chatOf(root);
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-img]:not([src])")) {
    const target = img.dataset.img ?? "";
    void loadImage(target, chatId).then((r) => {
      if (!img.isConnected) return;
      if (r.ok && r.src) { img.src = r.src; img.closest(".md-img-wrap")?.classList.add("loaded"); return; }
      const wrap = img.closest<HTMLElement>(".md-img-wrap");
      if (!wrap) return;
      // A preview under a file link just disappears (the link is still there); a Markdown image says why it is missing.
      if (wrap.dataset.preview) { wrap.remove(); return; }
      wrap.className = "md-img-missing";
      wrap.title = `${target}: ${r.detail ?? "not available"}`;
      wrap.textContent = `[image: ${img.alt || target}]`;
    });
  }
}

export const OPEN_IMAGE_EVENT = "flash:open-image";
/** Show an image in the full-window viewer (ImageViewer, mounted once per window). */
export function openImage(img: ViewImage): void {
  window.dispatchEvent(new CustomEvent<ViewImage>(OPEN_IMAGE_EVENT, { detail: img }));
}
