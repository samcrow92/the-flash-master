/**
 * Tracks whether files are being dragged over the window, for the "drop agent .md files" overlay.
 *
 * The old check cleared the overlay only on a `dragleave` whose target was the app root. When the cursor leaves the
 * window the leave fires on whatever child was under it, and on Windows a drag that ends in another app may send no
 * leave at all, so the overlay stuck. This tracker is a small pure reducer fed from window-level events:
 *  - enter/leave are counted (every element fires its own pair), and a leave to outside the window resets;
 *  - drop, dragend, window blur, Esc, a click and any mouse move with no button held end it (no mouse events fire
 *    during a real drag, so a move means the drag is over);
 *  - `dragover` repeats every ~50 ms while a drag hovers, so if none arrives for STALE_MS the drag went elsewhere.
 */

export const STALE_MS = 500;

export interface DragState {
  /** Overlay visible. */
  active: boolean;
  /** Nested dragenter count. */
  depth: number;
  /** Time of the last dragenter/dragover, for the staleness check. */
  last: number;
}

export type DragEvent =
  | { type: "enter"; files: boolean; at: number }
  | { type: "over"; files: boolean; at: number }
  /** `outside`: the leave has no relatedTarget, i.e. the cursor left the window. */
  | { type: "leave"; outside: boolean }
  | { type: "end" }
  | { type: "tick"; at: number };

export const idle: DragState = { active: false, depth: 0, last: 0 };

export function dragReducer(s: DragState, e: DragEvent): DragState {
  switch (e.type) {
    case "enter":
      return e.files ? { active: true, depth: s.depth + 1, last: e.at } : s;
    case "over":
      return e.files ? { active: true, depth: Math.max(s.depth, 1), last: e.at } : s;
    case "leave": {
      if (!s.active) return s;
      const depth = e.outside ? 0 : Math.max(0, s.depth - 1);
      return depth === 0 ? idle : { ...s, depth };
    }
    case "end":
      return s.active || s.depth ? idle : s;
    case "tick":
      return s.active && e.at - s.last > STALE_MS ? idle : s;
  }
}

export const hasFiles = (dt: DataTransfer | null): boolean =>
  !!dt && ([...dt.types].includes("Files") || [...dt.items].some((i) => i.kind === "file"));
