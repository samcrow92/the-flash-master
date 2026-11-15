import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * Windowed rendering for long, variable-height lists (the chat message list): only the items near the viewport are
 * mounted, the rest is stood in for by two spacers sized from measured (or estimated) heights.
 *
 * Scroll position is kept stable by anchoring: the first visible item and its distance from the top of the viewport are
 * remembered, and whenever heights change (an item is measured for the first time, a reply streams, a thread expands)
 * the scroll position is corrected so that item stays put. When the list is pinned to the bottom it simply stays there.
 */

/** Pixel offset of the top of each item; `offsets[n]` is the total height. */
export function prefixOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate: number): number[] {
  const out = new Array<number>(keys.length + 1);
  out[0] = 0;
  for (let i = 0; i < keys.length; i++) out[i + 1] = out[i]! + (heights.get(keys[i]!) ?? estimate);
  return out;
}

/** Index of the item that contains pixel `y` (clamped to the list). */
export function indexAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The [start, end) slice to mount for a viewport, with `overscan` pixels of slack above and below. */
export function visibleRange(offsets: readonly number[], scrollTop: number, viewport: number, overscan: number): [number, number] {
  const n = offsets.length - 1;
  if (n <= 0) return [0, 0];
  const start = indexAt(offsets, Math.max(0, scrollTop - overscan));
  const end = indexAt(offsets, scrollTop + viewport + overscan) + 1;
  return [start, Math.min(n, end)];
}

/** Typical height of the items measured so far — the stand-in for items not yet seen. */
export function estimateHeight(heights: ReadonlyMap<string, number>, fallback: number): number {
  if (!heights.size) return fallback;
  let sum = 0;
  for (const h of heights.values()) sum += h;
  return Math.max(24, Math.round(sum / heights.size));
}

/**
 * Measurements this close count as unchanged. Chromium rounds offsetHeight to whole pixels from the item's fractional
 * position on the page, so the same item can read 1 px apart whenever the slice above it changes. Counting that as a
 * change re-sized the spacers, which moved the item again, which flipped the rounding back: an endless measure loop
 * that hit React's "Maximum update depth exceeded" and unmounted the chat (the blank gray window).
 */
export const HEIGHT_SLACK = 1;
export function heightChanged(prev: number | undefined, next: number): boolean {
  return prev === undefined || Math.abs(prev - next) > HEIGHT_SLACK;
}

/**
 * Back-to-back synchronous re-measure passes allowed in one frame (React gives up after 50 nested updates). Past this,
 * the next pass waits for an animation frame: a layout that keeps moving costs a frame per pass instead of the app.
 */
export const MAX_SYNC_PASSES = 8;
export function nextPass(passes: number, changed: boolean): { passes: number; run: "none" | "now" | "next-frame" } {
  if (!changed) return { passes: 0, run: "none" };
  if (passes < MAX_SYNC_PASSES) return { passes: passes + 1, run: "now" };
  return { passes, run: "next-frame" };
}

/** Within this many pixels of the bottom counts as "at the bottom": new content keeps the list scrolled down. */
export const PIN_SLACK = 80;
const OVERSCAN = 900;
const FALLBACK = 140;

type Anchor = { key: string; delta: number };

export interface VirtualList {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  /** Ref callback for each mounted item's wrapper; the wrapper must carry `data-vkey`. */
  measure: (el: HTMLElement | null) => void;
  /** Scroll so the item with this key is in view (it may not be mounted yet). Returns false when the key is unknown. */
  scrollToKey: (key: string, block?: "start" | "center") => boolean;
  /** True while the list is following the bottom. */
  pinned: RefObject<boolean>;
}

/**
 * `listKey` identifies the list (the chat id): changing it starts again at the bottom.
 * `keys` are stable item ids in display order.
 */
export function useVirtualList(scrollRef: RefObject<HTMLElement | null>, keys: readonly string[], listKey: string): VirtualList {
  const heights = useRef(new Map<string, number>());
  const pinned = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const [rev, setRev] = useState(0); // bumped when measured heights change, to re-size the spacers
  const keysRef = useRef(keys);
  keysRef.current = keys;

  // Heights belong to one list; a new chat starts measuring afresh (and pinned to the bottom).
  const lastList = useRef(listKey);
  if (lastList.current !== listKey) { lastList.current = listKey; heights.current = new Map(); pinned.current = true; anchor.current = null; }

  const layout = useCallback(() => {
    const ks = keysRef.current;
    const est = estimateHeight(heights.current, FALLBACK);
    return { offsets: prefixOffsets(ks, heights.current, est), keys: ks };
  }, []);

  const offsets = useMemo(() => layout().offsets, [keys, rev, listKey, layout]);
  const total = offsets[offsets.length - 1] ?? 0;
  // Where the viewport will be once `restore` runs: the tail while pinned, otherwise wherever the anchor item lands with
  // the latest heights. Deriving it from the anchor (not the last scroll event) keeps the mounted slice stable while
  // fresh measurements move things around, so measuring converges in one or two passes.
  const ai = !pinned.current && anchor.current ? keys.indexOf(anchor.current.key) : -1;
  const top = pinned.current ? Math.max(0, total - view.height)
    : ai >= 0 ? offsets[ai]! + anchor.current!.delta
    : view.top;
  const [start, end] = visibleRange(offsets, top, view.height || 800, OVERSCAN);

  /** Remember which item is at the top of the viewport and how far into it we are. */
  const recordAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { offsets: off, keys: ks } = layout();
    if (!ks.length) { anchor.current = null; return; }
    const i = indexAt(off, el.scrollTop);
    anchor.current = { key: ks[i]!, delta: el.scrollTop - off[i]! };
  }, [layout, scrollRef]);

  /** Put the scroll position back where the anchor says (or at the bottom when pinned). */
  const restore = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinned.current) {
      const want = el.scrollHeight - el.clientHeight;
      if (Math.abs(el.scrollTop - want) > 0.5) el.scrollTop = want;
      return;
    }
    const a = anchor.current;
    if (!a) return;
    const { offsets: off, keys: ks } = layout();
    const i = ks.indexOf(a.key);
    if (i < 0) return;
    const want = off[i]! + a.delta;
    if (Math.abs(el.scrollTop - want) > 0.5) el.scrollTop = want;
  }, [layout, scrollRef]);

  /** Read the real heights of mounted items into the cache. Returns true when anything changed. */
  const readHeights = useCallback((els: Iterable<Element>) => {
    let changed = false;
    for (const node of els) {
      const k = (node as HTMLElement).dataset.vkey;
      if (!k) continue;
      const h = (node as HTMLElement).offsetHeight;
      if (heightChanged(heights.current.get(k), h)) { heights.current.set(k, h); changed = true; }
    }
    return changed;
  }, []);

  // One observer for all mounted items: a height change (streaming, an expanding thread or reasoning block) is
  // corrected for before paint, so the content under the reader's eyes doesn't move.
  const ro = useRef<ResizeObserver | null>(null);
  const mounted = useRef(new Set<HTMLElement>());
  if (!ro.current && typeof ResizeObserver !== "undefined") {
    ro.current = new ResizeObserver((entries) => {
      if (readHeights(entries.map((e) => e.target))) { restore(); setRev((r) => r + 1); }
    });
  }
  useEffect(() => () => ro.current?.disconnect(), []);
  const measure = useCallback((el: HTMLElement | null) => {
    // React calls ref callbacks with null on unmount; drop elements that left the DOM.
    if (!el) {
      for (const m of mounted.current) if (!m.isConnected) { ro.current?.unobserve(m); mounted.current.delete(m); }
      return;
    }
    if (mounted.current.has(el)) return;
    mounted.current.add(el);
    ro.current?.observe(el);
  }, []);

  // After every render: measure newly mounted items synchronously and re-anchor, before the browser paints.
  // Bounded: if measuring keeps changing the layout, later passes go to the next frame (see nextPass).
  const passes = useRef(0);
  const deferred = useRef(0);
  useLayoutEffect(() => {
    const step = nextPass(passes.current, readHeights(mounted.current));
    passes.current = step.passes;
    if (step.run === "now") setRev((r) => r + 1);
    else if (step.run === "next-frame" && !deferred.current) {
      deferred.current = requestAnimationFrame(() => { deferred.current = 0; passes.current = 0; setRev((r) => r + 1); });
    }
    restore();
  });
  useEffect(() => () => { if (deferred.current) cancelAnimationFrame(deferred.current); }, []);

  // Viewport size and scroll tracking.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
    let frame = 0;
    const sync = () => { frame = 0; setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight })); };
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
      recordAnchor();
      if (!frame) frame = requestAnimationFrame(sync);
    };
    const vro = new ResizeObserver(() => { restore(); sync(); });
    vro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    sync();
    return () => { vro.disconnect(); el.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [listKey, scrollRef, recordAnchor, restore]);

  const scrollToKey = useCallback((key: string, block: "start" | "center" = "center") => {
    const el = scrollRef.current;
    const { offsets: off, keys: ks } = layout();
    const i = ks.indexOf(key);
    if (!el || i < 0) return false;
    const h = off[i + 1]! - off[i]!;
    const delta = block === "center" ? Math.min(0, (h - el.clientHeight) / 2) : -12;
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0; // offsets start below the list's top padding
    pinned.current = false;
    anchor.current = { key, delta: delta + pad };
    el.scrollTop = off[i]! + delta + pad;
    setView({ top: el.scrollTop, height: el.clientHeight });
    return true;
  }, [layout, scrollRef]);

  return {
    start, end,
    padTop: offsets[start] ?? 0,
    padBottom: total - (offsets[end] ?? total),
    measure, scrollToKey, pinned,
  };
}

/**
 * UI state that survives an item scrolling out of the list and back (expanded tool output, "Show all" on reasoning…).
 * Kept per key for the session; bounded so it can't grow without limit.
 */
const kept = new Map<string, unknown>();
const KEPT_MAX = 2000;
export function useKeptState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial));
  const set = useCallback((next: T | ((p: T) => T)) => {
    setV((p) => {
      const val = typeof next === "function" ? (next as (p: T) => T)(p) : next;
      kept.delete(key);
      if (val === initial) return val;
      kept.set(key, val);
      if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
      return val;
    });
  }, [key, initial]);
  return [v, set];
}
