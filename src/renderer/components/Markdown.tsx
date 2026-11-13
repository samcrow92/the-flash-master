import { memo, useMemo, type MouseEvent } from "react";
import { Marked } from "marked";
import { fishboneSvg } from "./diagrams";

// Raw HTML in agent output is escaped, never rendered (agents can echo untrusted file content).
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => esc(text),
    link: ({ href, text }) => (/^(https?:|mailto:)/.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(text)}</a>` : esc(text)),
    image: ({ text }) => esc(`[image: ${text}]`),
    code: ({ text, lang }) => {
      if (lang === "ishikawa" || lang === "fishbone") {
        try { return `<div class="diagram-wrap">${fishboneSvg(JSON.parse(text))}</div>`; } catch { /* fall through: show the source */ }
      }
      return `<pre class="code"><div class="code-bar"><span class="code-lang">${esc(lang ?? "")}</span>`
        + `<button type="button" class="code-copy" title="Copy to clipboard">${COPY_SVG}<span>Copy</span></button></div><code>${esc(text)}</code></pre>`;
    },
    codespan: ({ text }) => `<code class="inline-code" title="Click to copy">${esc(text)}</code>`,
  },
});

const COPY_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CHECK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

/** Copy buttons on code blocks and click-to-copy on inline code (event delegation: the HTML is static). */
function onCopyClick(e: MouseEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
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
  return <div className="md" onClick={onCopyClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
