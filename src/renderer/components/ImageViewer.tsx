import { useEffect, useState } from "react";
import { ExternalLink, X } from "./icons";
import { OPEN_IMAGE_EVENT, loadImage, openImage, type ViewImage } from "../images";

/** Full-window image viewer (one per window): glass backdrop, fit-to-window, click the picture for actual size,
 *  Esc or a click outside closes. Opened from any chat image with openImage(). */
export function ImageViewer() {
  const [img, setImg] = useState<ViewImage | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const on = (e: Event) => { setImg((e as CustomEvent<ViewImage>).detail); setFull(false); };
    window.addEventListener(OPEN_IMAGE_EVENT, on);
    return () => window.removeEventListener(OPEN_IMAGE_EVENT, on);
  }, []);
  useEffect(() => {
    if (!img) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setImg(null); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [img]);
  // An attachment opens with its small thumbnail; swap in the full picture once it is read.
  useEffect(() => {
    const path = img?.path;
    if (!path || !img?.thumb) return;
    let live = true;
    void loadImage(path, img.chatId ?? null).then((r) => { if (live && r.ok && r.src) setImg((cur) => (cur?.path === path ? { ...cur, src: r.src!, thumb: false } : cur)); });
    return () => { live = false; };
  }, [img?.path, img?.chatId, img?.thumb]);

  if (!img) return null;
  const open = async () => {
    if (!img.path) return;
    const { api, useStore } = await import("../store");
    const r = await api().openLink(img.path, img.chatId ?? null).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
    if (!r.ok) useStore.getState().toast("error", r.detail);
  };
  return (
    <div className="img-viewer" role="dialog" aria-label={img.name ?? "Image"} onClick={() => setImg(null)}>
      <div className={`img-viewer-stage ${full ? "full" : ""}`} onClick={(e) => e.stopPropagation()}>
        <img src={img.src} alt={img.name ?? ""} title={full ? "Click to fit the window" : "Click for actual size"} onClick={() => setFull((f) => !f)} />
      </div>
      <div className="img-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="img-viewer-name" title={img.path ?? img.name}>{img.name || img.path?.split(/[\\/]/).pop() || "Image"}</span>
        {img.path && <button className="ghost tiny" onClick={() => void open()} title="Open with the default app"><ExternalLink size={13} /> Open</button>}
        <button className="ghost tiny" onClick={() => setImg(null)} title="Close (Esc)" aria-label="Close"><X size={14} /></button>
      </div>
    </div>
  );
}

/** One local image (from tool output or a path) as a clickable inline preview; renders nothing if it can't be shown. */
export function ChatImage({ target, chatId, name }: { target: string; chatId: string | null; name?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadImage(target, chatId).then((r) => { if (live) setSrc(r.ok && r.src ? r.src : null); });
    return () => { live = false; };
  }, [target, chatId]);
  if (!src) return null;
  const label = name ?? target.split(/[\\/]/).pop() ?? target;
  return (
    <button type="button" className="chat-img" title={`${target} — click to enlarge`} onClick={() => openImage({ src, name: label, path: target, chatId })}>
      <img src={src} alt={label} />
    </button>
  );
}
