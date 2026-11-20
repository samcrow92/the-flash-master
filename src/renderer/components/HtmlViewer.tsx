import { useEffect, useState } from "react";
import { ExternalLink, FileCode, RotateCw, X } from "./icons";
import { HTML_SANDBOX, OPEN_HTML_EVENT, type ViewHtml } from "../htmlPreview";

/** Full-window viewer for HTML reports (one per window), the HTML sibling of ImageViewer: the page in a sandboxed frame
 *  on a glass backdrop, a slim bar to reload it or open it in the browser. Esc or a click outside closes. */
export function HtmlViewer() {
  const [page, setPage] = useState<ViewHtml | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const on = (e: Event) => { setPage((e as CustomEvent<ViewHtml>).detail); setRev(0); };
    window.addEventListener(OPEN_HTML_EVENT, on);
    return () => window.removeEventListener(OPEN_HTML_EVENT, on);
  }, []);
  useEffect(() => {
    if (!page) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setPage(null); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [page]);

  if (!page) return null;
  const open = async () => {
    const { api, useStore } = await import("../store");
    const r = await api().openLink(page.path, page.chatId).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
    if (!r.ok) useStore.getState().toast("error", r.detail);
  };
  return (
    <div className="html-viewer" role="dialog" aria-label={page.name} onClick={() => setPage(null)}>
      <div className="html-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <FileCode size={14} className="html-viewer-icon" />
        <span className="html-viewer-name" title={page.path}>{page.name}</span>
        <button className="ghost tiny" onClick={() => setRev((r) => r + 1)} title="Reload the report (after the agent updated it)"><RotateCw size={13} /> Reload</button>
        <button className="ghost tiny" onClick={() => void open()} title="Open in your browser"><ExternalLink size={13} /> Browser</button>
        <button className="ghost tiny" onClick={() => setPage(null)} title="Close (Esc)" aria-label="Close"><X size={14} /></button>
      </div>
      <div className="html-viewer-stage" onClick={(e) => e.stopPropagation()}>
        <iframe key={rev} className="html-frame" sandbox={HTML_SANDBOX} title={page.name} src={page.url} />
      </div>
    </div>
  );
}
