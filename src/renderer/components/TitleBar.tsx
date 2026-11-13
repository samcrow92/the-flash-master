import { useEffect, useState } from "react";
import { api, useStore } from "../store";

const VIEW_TITLES: Record<string, string> = {
  agents: "Agents", dashboard: "Dashboard", tasks: "Tasks", jazz: "IBM Jazz", settings: "Settings", flow: "Progress",
  marketplace: "Marketplace", docs: "Documentation",
};

/**
 * Frameless window title bar, macOS style: traffic lights on the left (close · minimise · zoom), the current view in
 * the middle, and the whole strip is a drag handle (double-click zooms; Windows Snap still works through it).
 * On macOS the system draws its own traffic lights, so only the spacer is kept.
 */
export function TitleBar() {
  const ws = useStore((s) => s.window);
  const view = useStore((s) => s.view);
  const chatTitle = useStore((s) => (s.view.kind === "chat" ? s.chatById[s.view.chatId]?.title : undefined));
  const [hover, setHover] = useState(false);
  const title = view.kind === "chat" ? chatTitle ?? "Chat" : VIEW_TITLES[view.kind] ?? "";
  const native = ws?.platform === "darwin";
  const blurred = ws ? !ws.focused : false;

  // Alt+F4 still works natively; give keyboard users the familiar shortcuts for the other two as well.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "F11") { e.preventDefault(); void api().windowControl("maximize"); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className={`titlebar ${blurred ? "blurred" : ""}`} onDoubleClick={(e) => { if (e.target === e.currentTarget) void api().windowControl("maximize"); }}>
      {native ? <span className="lights-spacer" /> : (
        <div className={`lights ${hover ? "hover" : ""}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          <button className="light close" title="Close" aria-label="Close" onClick={() => void api().windowControl("close")}><Glyph kind="close" /></button>
          <button className="light min" title="Minimise" aria-label="Minimise" onClick={() => void api().windowControl("minimize")}><Glyph kind="min" /></button>
          <button className="light max" title={ws?.maximized ? "Restore" : "Zoom"} aria-label={ws?.maximized ? "Restore" : "Maximise"}
            onClick={() => void api().windowControl("maximize")}><Glyph kind={ws?.maximized || ws?.fullscreen ? "restore" : "max"} /></button>
        </div>
      )}
      <div key={title} className="titlebar-title">{title}</div>
      <span className="lights-spacer" />
    </header>
  );
}

/** The tiny glyphs macOS shows inside the lights on hover. */
function Glyph({ kind }: { kind: "close" | "min" | "max" | "restore" }) {
  return (
    <svg viewBox="0 0 12 12" width="8" height="8" aria-hidden="true">
      {kind === "close" && <path d="M3 3l6 6M9 3l-6 6" />}
      {kind === "min" && <path d="M2.5 6h7" />}
      {kind === "max" && <path className="fill" d="M3.2 3.2h4.2L3.2 7.4zM8.8 8.8H4.6l4.2-4.2z" />}
      {kind === "restore" && <path className="fill" d="M6 6V1.8L1.8 6zM6 6v4.2L10.2 6z" />}
    </svg>
  );
}
