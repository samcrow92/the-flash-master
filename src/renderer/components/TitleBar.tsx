import { useEffect } from "react";
import { api, toggleTheme, useStore } from "../store";
import { Moon, Sun } from "./icons";
import appIcon from "../assets/app-icon.png";
import { TerminalButton } from "./TerminalPanel";

/**
 * Frameless window chrome with no visible bar: the app icon floats at the top left, and the terminal button, the light/dark toggle plus
 * Windows-style minimise · maximise · close buttons float at the top right. The empty strip between them stays a drag
 * handle (double-click maximises; Windows Snap still works through it).
 * On macOS the system draws its own traffic lights at the top left, so only a spacer is kept there.
 */
export function TitleBar({ terminal = false }: { terminal?: boolean }) {
  const ws = useStore((s) => s.window);
  const native = ws?.platform === "darwin";
  const blurred = ws ? !ws.focused : false;
  const maximized = !!(ws?.maximized || ws?.fullscreen);
  const light = useStore((s) => s.settings?.general.theme === "light") || document.documentElement.dataset.theme === "light";

  // Alt+F4 still works natively; F11 toggles maximise for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "F11") { e.preventDefault(); void api().windowControl("maximize"); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className={`titlebar ${blurred ? "blurred" : ""}`} onDoubleClick={(e) => { if (e.target === e.currentTarget) void api().windowControl("maximize"); }}>
      {native ? <span className="lights-spacer" /> : <img className="titlebar-icon" src={appIcon} alt="TheFlashMaster" draggable={false} />}
      <div className="titlebar-right">
        {terminal && <TerminalButton />}
        <button className="theme-toggle" title={light ? "Switch to dark mode" : "Switch to light mode"} aria-label={light ? "Switch to dark mode" : "Switch to light mode"} onClick={() => void toggleTheme()}>
          <span key={light ? "moon" : "sun"} className="theme-icon">{light ? <Moon size={15} /> : <Sun size={15} />}</span>
        </button>
        {!native && (
          <div className="win-controls">
            <button className="win-btn min" title="Minimise" aria-label="Minimise" onClick={() => void api().windowControl("minimize")}><Glyph kind="min" /></button>
            <button className="win-btn max" title={maximized ? "Restore down" : "Maximise"} aria-label={maximized ? "Restore down" : "Maximise"}
              onClick={() => void api().windowControl("maximize")}><Glyph kind={maximized ? "restore" : "max"} /></button>
            <button className="win-btn close" title="Close" aria-label="Close" onClick={() => void api().windowControl("close")}><Glyph kind="close" /></button>
          </div>
        )}
      </div>
    </header>
  );
}

/** Windows 11 caption glyphs (10 px, hairline strokes). */
function Glyph({ kind }: { kind: "close" | "min" | "max" | "restore" }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {kind === "min" && <path d="M0 5.5h10" />}
      {kind === "max" && <rect x="0.5" y="0.5" width="9" height="9" rx="1" />}
      {kind === "restore" && <><rect x="0.5" y="2.5" width="7" height="7" rx="1" /><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" /></>}
      {kind === "close" && <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />}
    </svg>
  );
}
