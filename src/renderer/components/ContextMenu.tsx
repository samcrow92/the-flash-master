import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  separator?: boolean;
}

interface MenuState {
  open: { x: number; y: number; items: MenuItem[] } | null;
  show: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

export const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  close: () => set({ open: null }),
}));

/** Open a context menu at the mouse (right-click) or under an element ("…" button). */
export function openMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void; currentTarget?: EventTarget | null },
  items: MenuItem[], anchor = false): void {
  e.preventDefault();
  e.stopPropagation();
  if (anchor && e.currentTarget instanceof HTMLElement) {
    const r = e.currentTarget.getBoundingClientRect();
    useMenu.getState().show(r.left, r.bottom + 4, items);
  } else useMenu.getState().show(e.clientX, e.clientY, items);
}

export function ContextMenuHost() {
  const { open, close } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(open.x, window.innerWidth - r.width - 8), y: Math.min(open.y, window.innerHeight - r.height - 8) });
    setActive(-1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const items = open.items.map((it, i) => ({ it, i })).filter(({ it }) => !it.separator && !it.disabled);
      if (e.key === "Escape") close();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = items.findIndex(({ i }) => i === active);
        const next = items[(idx + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
        if (next) setActive(next.i);
      }
      if (e.key === "Enter" && active >= 0) { const it = open.items[active]; close(); it?.onClick?.(); }
    };
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [open, active, close]);

  if (!open) return null;
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {open.items.map((it, i) => it.separator ? <div key={i} className="ctx-sep" /> : (
        <button key={i} role="menuitem" className={`ctx-item ${it.danger ? "danger" : ""} ${active === i ? "active" : ""}`} disabled={it.disabled}
          onMouseEnter={() => setActive(i)} onClick={() => { close(); it.onClick?.(); }}>
          <span className="ctx-icon">{it.icon}</span><span className="ctx-label">{it.label}</span>{it.hint && <span className="ctx-hint">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}
