/**
 * Drag-to-resize sizes for the side panels (sidebar, Progress/Artifacts) and the terminal.
 *
 * Sizes live in CSS variables on <html> and in localStorage, never in React state: a drag writes the variable once per
 * animation frame and nothing re-renders, so the chat's message list only sees its width change (it re-measures through
 * its ResizeObserver, as on a window resize) and no render cascade can start from here.
 */

export type PanelId = "sidebar" | "side" | "termW" | "termH";

export interface PanelSpec {
  /** CSS variable the stylesheet reads (with the default as fallback). */
  cssVar: string;
  def: number;
  min: number;
  max: number;
}

export const PANELS: Record<PanelId, PanelSpec> = {
  sidebar: { cssVar: "--sidebar-w", def: 252, min: 200, max: 480 },
  side: { cssVar: "--side-w", def: 380, min: 300, max: 900 },
  termW: { cssVar: "--term-w", def: 860, min: 420, max: 4000 },
  termH: { cssVar: "--term-h", def: 420, min: 160, max: 4000 },
};

/** The chat keeps at least this much width while a panel next to it grows (its composer and mode bar need ~540px). */
export const MIN_CHAT = 560;
export const STORE_KEY = "panelSizes";

export const clamp = (v: number, min: number, max: number) => Math.round(Math.min(Math.max(v, min), Math.max(min, max)));

/** Saved sizes, keeping only known panels with sane numbers (anything else falls back to the default). */
export function parseSizes(raw: string | null | undefined): Partial<Record<PanelId, number>> {
  if (!raw) return {};
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return {}; }
  if (!data || typeof data !== "object") return {};
  const out: Partial<Record<PanelId, number>> = {};
  for (const id of Object.keys(PANELS) as PanelId[]) {
    const v = (data as Record<string, unknown>)[id];
    if (typeof v === "number" && Number.isFinite(v)) out[id] = clamp(v, PANELS[id].min, PANELS[id].max);
  }
  return out;
}

/**
 * New size for a drag. `dir` is +1 when dragging away from the panel grows it (a right or bottom edge), -1 for a left
 * edge. `room` is how far the panel may grow beyond `start` (e.g. what the chat can give up); it never forces a shrink.
 */
export function dragSize(id: PanelId, start: number, delta: number, dir: 1 | -1, room = Infinity): number {
  const s = PANELS[id];
  return clamp(start + dir * delta, s.min, Math.min(s.max, start + Math.max(0, room)));
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

let sizes: Partial<Record<PanelId, number>> | null = null;
function loaded() {
  if (!sizes) sizes = parseSizes(storage()?.getItem(STORE_KEY));
  return sizes;
}

export const panelSize = (id: PanelId) => loaded()[id] ?? PANELS[id].def;

function setVar(id: PanelId, v: number | null) {
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (!root) return;
  if (v == null) root.style.removeProperty(PANELS[id].cssVar);
  else root.style.setProperty(PANELS[id].cssVar, `${v}px`);
}

/** Live update during a drag (not saved). */
export const previewPanel = (id: PanelId, v: number) => setVar(id, v);

export function savePanel(id: PanelId, v: number | null) {
  const all = loaded();
  if (v == null || v === PANELS[id].def) delete all[id]; else all[id] = clamp(v, PANELS[id].min, PANELS[id].max);
  setVar(id, all[id] ?? null);
  try { storage()?.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

/** Put the saved sizes on <html> at startup. */
export function applyPanelSizes() {
  for (const id of Object.keys(PANELS) as PanelId[]) setVar(id, loaded()[id] ?? null);
}
