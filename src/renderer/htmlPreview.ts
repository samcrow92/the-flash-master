/**
 * HTML reports inside chats. A link to a local .html file (an agent's analysis report) gets a report card under it:
 * "Preview" renders the page right there in the chat, "Full view" opens the full-window viewer (HtmlViewer). The page
 * is served by the main process on flash-report:// and shown in a sandboxed frame (see src/main/html-preview.ts).
 */

export interface ViewHtml { url: string; name: string; path: string; chatId: string | null }
type Preview = { ok: true; url: string; path: string; name: string } | { ok: false; detail: string };

/** The frame's sandbox: report scripts and diagrams run, but in an opaque origin with no way into the app or the window. */
export const HTML_SANDBOX = "allow-scripts allow-popups";

const cache = new Map<string, Preview & { at: number }>();
// A missing report is checked again after a while: agents often link a report before they have finished writing it.
const RETRY_MS = 8000;
const pending = new Map<string, Promise<Preview>>();
const key = (target: string, chatId: string | null) => `${chatId ?? ""}|${target}`;
/** Reports whose inline preview is open, so a re-rendered reply (streaming, edits) keeps them open. */
const openInline = new Set<string>();

export function previewHtml(target: string, chatId: string | null): Promise<Preview> {
  const k = key(target, chatId);
  const hit = cache.get(k);
  if (hit && (hit.ok || Date.now() - hit.at < RETRY_MS)) return Promise.resolve(hit);
  const running = pending.get(k);
  if (running) return running;
  const p = (async (): Promise<Preview> => {
    try {
      // Loaded lazily so Markdown stays renderable outside the app (tests, static rendering).
      const { api, useStore } = await import("./store");
      const st = useStore.getState();
      const r = await api().previewHtml(target, chatId ?? (st.view.kind === "chat" ? st.view.chatId : null));
      cache.set(k, { ...r, at: Date.now() });
      return r;
    } catch (e) {
      return { ok: false, detail: String((e as Error)?.message ?? e) };
    } finally { pending.delete(k); }
  })();
  pending.set(k, p);
  return p;
}

export const OPEN_HTML_EVENT = "flash:open-html";
/** Show a report in the full-window viewer (HtmlViewer, mounted once per window). */
export function openHtml(v: ViewHtml): void {
  window.dispatchEvent(new CustomEvent<ViewHtml>(OPEN_HTML_EVENT, { detail: v }));
}

/** A sandboxed frame showing a report (inline in a card, or in the viewer). */
export function makeFrame(url: string, title: string): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.className = "html-frame";
  f.setAttribute("sandbox", HTML_SANDBOX);
  f.title = title;
  f.src = url;
  return f;
}

const chatOf = (el: Element) => el.closest<HTMLElement>("[data-chat]")?.dataset.chat ?? null;

function setInline(card: HTMLElement, url: string, name: string, open: boolean): void {
  const btn = card.querySelector<HTMLButtonElement>('[data-html-act="inline"]');
  let body = card.querySelector<HTMLElement>(".html-card-body");
  if (!open) { body?.remove(); card.classList.remove("open"); if (btn) btn.textContent = "Preview"; return; }
  if (!body) {
    body = document.createElement("span");
    body.className = "html-card-body";
    body.appendChild(makeFrame(url, name));
    card.appendChild(body);
  }
  card.classList.add("open");
  if (btn) btn.textContent = "Hide";
}

/** Fill in the report cards of a rendered Markdown block: each card moves below its paragraph (so the sentence stays whole),
 *  is hidden while the file can't be read, and a report linked twice (URL and relative path) shows one card. */
export function hydrateHtmlCards(root: HTMLElement): void {
  const seen = new Set<string>();
  const after = new Map<Element, Element>();
  for (const card of root.querySelectorAll<HTMLElement>(".html-card[data-html]")) {
    const target = card.dataset.html ?? "";
    if (seen.has(target)) { card.remove(); continue; }
    seen.add(target);
    const block = card.parentElement?.closest("p, li");
    if (block && root.contains(block)) {
      if (block.tagName === "LI") block.appendChild(card);
      else { (after.get(block) ?? block).after(card); after.set(block, card); }
    }
    const chatId = chatOf(card);
    void previewHtml(target, chatId).then((r) => {
      if (!card.isConnected) return;
      if (!r.ok) { card.hidden = true; card.title = r.detail; return; }
      card.dataset.url = r.url;
      card.dataset.name = r.name;
      card.dataset.path = r.path;
      card.hidden = false;
      if (openInline.has(key(target, chatId))) setInline(card, r.url, r.name, true);
      onePerReport(root);
    });
  }
}

/** Only the first card (in reading order) of each report file stays visible. */
function onePerReport(root: HTMLElement): void {
  const shown = new Set<string>();
  for (const card of root.querySelectorAll<HTMLElement>(".html-card[data-path]")) {
    const p = card.dataset.path!.toLowerCase();
    if (shown.has(p)) { card.hidden = true; card.dataset.dup = "1"; }
    else { shown.add(p); if (card.dataset.dup) { card.hidden = false; delete card.dataset.dup; } }
  }
}

/** A click on a card button (event delegation from Markdown). Returns true when it handled the click. */
export function onHtmlCardClick(target: HTMLElement): boolean {
  const btn = target.closest<HTMLElement>("[data-html-act]");
  const card = btn?.closest<HTMLElement>(".html-card");
  if (!btn || !card) return false;
  const { url, name = "Report", path = card.dataset.html ?? "" } = card.dataset;
  const chatId = chatOf(card);
  const act = btn.dataset.htmlAct;
  if (act === "browser") {
    void import("./store").then(async ({ api, useStore }) => {
      const r = await api().openLink(card.dataset.html ?? path, chatId).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
      if (!r.ok) useStore.getState().toast("error", r.detail);
    });
    return true;
  }
  if (!url) return true; // still being checked
  if (act === "full") { openHtml({ url, name, path, chatId }); return true; }
  const k = key(card.dataset.html ?? "", chatId);
  const open = !card.classList.contains("open");
  if (open) openInline.add(k); else openInline.delete(k);
  setInline(card, url, name, open);
  return true;
}
