import { memo, useMemo } from "react";
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
      return `<pre class="code"><div class="code-lang">${esc(lang ?? "")}</div><code>${esc(text)}</code></pre>`;
    },
  },
});

/** Hide the machine-readable <result> block's tags but keep its content readable. */
const prettify = (s: string) => s.replace(/<result>/gi, "\n\n**Result**\n\n").replace(/<\/result>/gi, "");

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md.parse(prettify(text), { async: false }) as string, [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});
