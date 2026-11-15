import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { dragSize, MIN_CHAT, PANELS, panelSize, previewPanel, savePanel, type PanelId } from "../panelSize";

/**
 * A thin grab strip on a panel's edge: drag to resize, double-click to reset, arrow keys when focused.
 * `edge` is the side of the panel the strip sits on. Side panels grow only as far as the chat can spare.
 */
export function ResizeHandle({ panel, edge, label }: { panel: PanelId; edge: "left" | "right" | "bottom"; label: string }) {
  const drag = useRef<{ start: number; from: number; room: number; frame: number; next: number } | null>(null);
  const vertical = edge === "bottom";
  const dir: 1 | -1 = edge === "left" ? -1 : 1;
  const pos = (e: PointerEvent) => (vertical ? e.clientY : e.clientX);

  /** How far this panel may grow: what the chat (or the open page) can spare, or what's left of the window for the terminal. */
  const room = (start: number) => {
    if (panel === "termW") return innerWidth - 20 - start;
    if (panel === "termH") return innerHeight - 60 - start;
    const c = document.querySelector<HTMLElement>(".chat-layout > .chat") ?? document.querySelector<HTMLElement>(".main");
    return c ? c.offsetWidth - MIN_CHAT : Infinity;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const host = el.parentElement;
    const start = host ? Math.round(vertical ? host.offsetHeight : host.offsetWidth) : panelSize(panel);
    drag.current = { start, from: pos(e), room: room(start), frame: 0, next: start };
    document.documentElement.classList.add("resizing", vertical ? "resizing-v" : "resizing-h");
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.next = dragSize(panel, d.start, pos(e) - d.from, dir, d.room);
    // One style write per frame, however fast the pointer events come.
    if (!d.frame) d.frame = requestAnimationFrame(() => { if (drag.current) { drag.current.frame = 0; previewPanel(panel, drag.current.next); } });
  };

  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.documentElement.classList.remove("resizing", "resizing-v", "resizing-h");
    if (d.next !== d.start) savePanel(panel, d.next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow: Record<string, number> = vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: dir, ArrowLeft: -dir };
    const step = grow[e.key];
    if (!step) return;
    e.preventDefault();
    savePanel(panel, dragSize(panel, panelSize(panel), step * (e.shiftKey ? 64 : 16), 1));
  };

  const s = PANELS[panel];
  return (
    <div className={`resize-handle rh-${edge}`} role="separator" aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-label={label} aria-valuemin={s.min} aria-valuemax={s.max} tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end}
      onDoubleClick={() => savePanel(panel, null)} onKeyDown={onKeyDown} />
  );
}
