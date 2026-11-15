import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, useStore } from "../store";
import { Maximize2, Minimize2, Plus, SquareTerminal, X } from "./icons";

/**
 * Integrated terminal: xterm.js (the terminal VS Code uses) on a real shell in main (node-pty, ConPTY on Windows).
 * It drops down from the title bar as a glass panel and can expand to fill the window. Hiding keeps the shells running;
 * closing a tab (or typing `exit`) ends that shell.
 */
interface Tab { id: string; shell: string; cwd: string }
interface TermUi {
  open: boolean;
  expanded: boolean;
  tabs: Tab[];
  active: string | null;
  toggle(): void;
  setExpanded(v: boolean): void;
}
export const useTerminalUi = create<TermUi>((set) => ({
  open: false, expanded: false, tabs: [], active: null,
  toggle: () => set((s) => ({ open: !s.open })),
  setExpanded: (v) => set({ expanded: v }),
}));

/** Live xterm instances by shell id; output that arrives before its instance exists waits in `early`. */
const terms = new Map<string, { term: Terminal; fit: FitAddon }>();
const early = new Map<string, string>();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.flash.onEvent((e) => {
    if (e.type === "terminal.data") {
      const t = terms.get(e.id);
      if (t) t.term.write(e.data); else early.set(e.id, (early.get(e.id) ?? "") + e.data);
    } else if (e.type === "terminal.exit") {
      dropTab(e.id);
    }
  });
}

function dropTab(id: string) {
  early.delete(id); // its TermView unmounts and disposes the xterm instance
  useTerminalUi.setState((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id);
    const active = s.active === id ? tabs[tabs.length - 1]?.id ?? null : s.active;
    return { tabs, active, open: tabs.length ? s.open : false };
  });
}

async function newTab() {
  listen();
  const st = useStore.getState();
  const cwd = st.projects.find((p) => p.id === st.currentProjectId)?.path ?? null;
  try {
    const t = await api().terminalOpen({ cols: 100, rows: 24, cwd });
    useTerminalUi.setState((s) => ({ tabs: [...s.tabs, t], active: t.id, open: true }));
  } catch (e) {
    st.toast("error", `Could not start a terminal: ${String((e as Error)?.message ?? e)}`);
  }
}

function closeTab(id: string) {
  void api().terminalClose(id);
  dropTab(id);
}

/** Title bar button: opens the panel (starting a shell the first time), or hides it. Ctrl+` does the same. */
export function TerminalButton() {
  const open = useTerminalUi((s) => s.open);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" && e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); toggleTerminal(); }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);
  const label = open ? "Hide terminal (Ctrl+`)" : "Terminal (Ctrl+`)";
  return (
    <button className={`theme-toggle term-toggle ${open ? "on" : ""}`} title={label} aria-label={label} aria-expanded={open} onClick={toggleTerminal}>
      <SquareTerminal size={15} />
    </button>
  );
}

export function toggleTerminal() {
  const s = useTerminalUi.getState();
  if (!s.open && !s.tabs.length) void newTab();
  else s.toggle();
}

export function TerminalPanel() {
  const { open, expanded, tabs, active, setExpanded } = useTerminalUi();
  if (!tabs.length) return null;
  return (
    <section className={`term-panel ${open ? "open" : ""} ${expanded ? "expanded" : ""}`} aria-hidden={!open} aria-label="Terminal">
      <header className="term-head">
        <div className="term-tabs" role="tablist">
          {tabs.map((t, i) => (
            <div key={t.id} role="tab" aria-selected={t.id === active} className={`term-tab ${t.id === active ? "active" : ""}`} title={t.cwd}
              onClick={() => useTerminalUi.setState({ active: t.id })}>
              <SquareTerminal size={13} /><span>{t.shell}{tabs.length > 1 ? ` ${i + 1}` : ""}</span>
              <button className="term-x" title="Close terminal" aria-label="Close terminal" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><X size={12} /></button>
            </div>
          ))}
          <button className="term-btn" title="New terminal" aria-label="New terminal" onClick={() => void newTab()}><Plus size={14} /></button>
        </div>
        <div className="term-actions">
          <button className="term-btn" title={expanded ? "Restore size" : "Expand"} aria-label={expanded ? "Restore size" : "Expand"} onClick={() => setExpanded(!expanded)}>
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button className="term-btn" title="Hide (shells keep running)" aria-label="Hide terminal" onClick={() => useTerminalUi.setState({ open: false })}><X size={14} /></button>
        </div>
      </header>
      <div className="term-body">
        {tabs.map((t) => <TermView key={t.id} id={t.id} visible={open && t.id === active} />)}
      </div>
    </section>
  );
}

function TermView({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const light = useStore((s) => s.settings?.general.theme === "light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 13, lineHeight: 1.15, cursorBlink: true, cursorStyle: "bar", allowTransparency: true, scrollback: 5000,
      theme: palette(document.documentElement.dataset.theme === "light"),
      // ConPTY already reflows; tell xterm so wrapped lines and the cursor stay right on Windows.
      windowsPty: navigator.userAgent.includes("Windows") ? { backend: "conpty" } : undefined,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "`" && e.ctrlKey) return false; // the toggle shortcut
      // Like VS Code: Ctrl+C copies when text is selected (otherwise it interrupts), Ctrl+V pastes.
      if (mod && !e.altKey && e.key.toLowerCase() === "c" && term.hasSelection()) { void navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
      if (mod && !e.altKey && e.key.toLowerCase() === "v") return false; // the browser's paste event feeds xterm
      return true;
    });
    term.onData((d) => void api().terminalWrite(id, d));
    term.onResize(({ cols, rows }) => void api().terminalResize(id, cols, rows));
    terms.set(id, { term, fit });
    const pending = early.get(id);
    if (pending) { term.write(pending); early.delete(id); }
    const refit = () => { if (el.offsetWidth > 0 && el.offsetHeight > 0) { try { fit.fit(); } catch { /* not laid out yet */ } } };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    refit();
    setReady(true);
    return () => { ro.disconnect(); if (terms.get(id)?.term === term) terms.delete(id); term.dispose(); };
  }, [id]);

  useEffect(() => { const t = terms.get(id); if (t) t.term.options.theme = palette(light); }, [light, id]);
  useEffect(() => {
    const t = terms.get(id);
    if (!visible || !t || !ready) return;
    const h = setTimeout(() => { try { t.fit.fit(); } catch { /* hidden */ } t.term.focus(); }, 60);
    return () => clearTimeout(h);
  }, [visible, ready, id]);

  return <div ref={host} className={`term-view ${visible ? "visible" : ""}`} data-term={id} />;
}

/** Transparent background so the glass shows through; ANSI colours follow VS Code's dark and light terminal themes. */
function palette(light: boolean): ITheme {
  return light
    ? {
      background: "#00000000", foreground: "#1d1d1f", cursor: "#1d1d1f", cursorAccent: "#ffffff", selectionBackground: "rgba(0, 122, 255, .22)",
      black: "#000000", red: "#cd3131", green: "#107c10", yellow: "#949800", blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
      brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
    }
    : {
      background: "#00000000", foreground: "#e6e8ef", cursor: "#ffcc00", cursorAccent: "#1a1400", selectionBackground: "rgba(255, 255, 255, .2)",
      black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
      brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5",
    };
}
