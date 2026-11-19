import { memo, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { BARE_LOCAL_PATH, DATA_IMAGE, WEB_LINK, isLocalImage, isLocalPathLink, trimTrailingPunctuation } from "@shared/links";
import { cachedImage, chatOf, hydrateImages, openImage } from "../images";
import { Marked } from "marked";
import { fishboneSvg } from "@shared/diagrams";

// Raw HTML in agent output is escaped, never rendered (agents can echo untrusted file content).
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

/** Web links and local files (an agent's .html report, a doc it wrote) become clickable; a click goes through
 *  api.openLink, where the main process decides what may be opened (src/main/links.ts). Other schemes stay text. */
function linkHtml(href: string, inner: string): string | null {
  if (WEB_LINK.test(href)) return `<a href="${attr(href)}" data-link="${attr(href)}" target="_blank" rel="noreferrer" title="${attr(href)}">${inner}</a>`;
  if (isLocalPathLink(href)) return `<a href="#" class="file-link" data-link="${attr(href)}" title="Open ${attr(href)}">${FILE_SVG}${inner}</a>`;
  return null;
}

/** An inline picture. Local files are read by the main process after rendering (hydrateImages), since the page only loads
 *  data: images; `preview` marks the picture shown under a link to an image file (it just disappears if unreadable). */
function imageHtml(src: string, alt: string, preview = false): string {
  if (DATA_IMAGE.test(src)) return `<span class="md-img-wrap loaded"><img class="md-img" src="${attr(src.replace(/\s+/g, ""))}" alt="${attr(alt)}" title="Click to enlarge" /></span>`;
  const have = cachedImage(src);
  return `<span class="md-img-wrap${have ? " loaded" : ""}"${preview ? ' data-preview="1"' : ""}><img class="md-img" data-img="${attr(src)}"`
    + `${have ? ` src="${attr(have)}"` : ""} alt="${attr(alt)}" title="${attr(src)} — click to enlarge" /></span>`;
}
/** A link; links to local image files also get an inline preview. */
function linkWithPreview(href: string, inner: string): string | null {
  const a = linkHtml(href, inner);
  return a && isLocalImage(href) ? `${a}${imageHtml(href, href.split(/[\\/]/).pop() ?? "", true)}` : a;
}

const md = new Marked({
  gfm: true,
  breaks: true,
  extensions: [{
    // Bare file:///… URLs and C:\… paths in plain text (agents often paste the path of a report they just wrote).
    name: "localPath",
    level: "inline",
    start: (src: string) => src.match(BARE_LOCAL_PATH)?.index,
    tokenizer(src: string) {
      const m = new RegExp(`^${BARE_LOCAL_PATH.source}`).exec(src);
      if (!m) return undefined;
      const raw = trimTrailingPunctuation(m[0]);
      return raw.length > 3 ? { type: "localPath", raw, text: raw } : undefined;
    },
    renderer: (t) => linkWithPreview(t.text as string, esc(t.text as string)) ?? esc(t.text as string),
  }],
  renderer: {
    html: ({ text }) => esc(text),
    link: ({ href, text }) => linkWithPreview(href, esc(text)) ?? esc(text),
    // Local and data: images show inline; web images stay a link (the app never loads remote content by itself).
    image: ({ href, text }) => {
      const src = String(href ?? "").trim();
      if (DATA_IMAGE.test(src) || isLocalPathLink(src)) return imageHtml(src, text);
      return linkHtml(src, esc(`[image: ${text || src}]`)) ?? esc(`[image: ${text}]`);
    },
    code: ({ text, lang }) => {
      if (lang === "ishikawa" || lang === "fishbone") {
        try { return `<div class="diagram-wrap">${fishboneSvg(JSON.parse(text))}</div>`; } catch { /* fall through: show the source */ }
      }
      return `<pre class="code"><div class="code-bar"><span class="code-lang">${esc(lang ?? "")}</span>`
        + `<button type="button" class="code-copy" title="Copy to clipboard">${COPY_SVG}<span>Copy</span></button></div><code>${esc(text)}</code></pre>`;
    },
    // `C:\out\report.html` or `https://…` in backticks opens on click; other inline code is click-to-copy.
    codespan: ({ text: raw }) => {
      return (/^\S+$/.test(raw) && (WEB_LINK.test(raw) || (isLocalPathLink(raw) && /[\\/]/.test(raw)))
        ? linkHtml(raw, `<code class="inline-code">${esc(raw)}</code>`) : null) ?? `<code class="inline-code" title="Click to copy">${esc(raw)}</code>`;
    },
  },
});

const COPY_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const FILE_SVG = `<svg class="file-link-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`;
const CHECK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

/** Links open through the main process; the chat (for relative paths) is the nearest [data-chat] or the open chat. */
function onLinkClick(e: MouseEvent<HTMLDivElement>, a: HTMLAnchorElement): void {
  e.preventDefault();
  const target = a.dataset.link ?? "";
  const inChat = a.closest<HTMLElement>("[data-chat]")?.dataset.chat;
  // The store is loaded lazily so this component stays renderable outside the app (tests, static rendering).
  void import("../store").then(async ({ api, useStore }) => {
    const st = useStore.getState();
    const chatId = inChat ?? (st.view.kind === "chat" ? st.view.chatId : null);
    try {
      const r = await api().openLink(target, chatId);
      if (!r.ok) st.toast("error", r.detail);
      else if (r.detail !== "Opened." && !r.detail.startsWith("Opened in")) st.toast("info", r.detail);
    } catch (err) { st.toast("error", String((err as Error)?.message ?? err)); }
  });
}

/** Link clicks, copy buttons on code blocks and click-to-copy on inline code (event delegation: the HTML is static). */
function onCopyClick(e: MouseEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLImageElement && target.classList.contains("md-img") && target.src) {
    e.preventDefault();
    const path = target.dataset.img;
    openImage({ src: target.src, name: target.alt || path?.split(/[\\/]/).pop(), path, chatId: chatOf(target) });
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a[data-link]");
  if (link) { onLinkClick(e, link); return; }
  const btn = target.closest<HTMLButtonElement>(".code-copy");
  const inline = !btn ? target.closest<HTMLElement>("code.inline-code") : null;
  const el = btn ? btn.closest("pre")?.querySelector("code") : inline;
  if (!el) return;
  e.preventDefault();
  void navigator.clipboard.writeText(el.textContent ?? "");
  const host = btn ?? inline!;
  host.classList.add("copied");
  if (btn) btn.innerHTML = `${CHECK_SVG}<span>Copied</span>`;
  window.setTimeout(() => { host.classList.remove("copied"); if (btn) btn.innerHTML = `${COPY_SVG}<span>Copy</span>`; }, 1400);
}

/** Hide the machine-readable <result> block's tags but keep its content readable. */
const prettify = (s: string) => s.replace(/<result>/gi, "\n\n**Result**\n\n").replace(/<\/result>/gi, "");

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md.parse(prettify(text), { async: false }) as string, [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current && html.includes("data-img=")) hydrateImages(ref.current); }, [html]);
  return <div ref={ref} className="md" onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
