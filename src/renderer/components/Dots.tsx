import { useEffect, useState, type CSSProperties } from "react";

/**
 * Playful loading indicator: 3, 4 or 5 glassy dots with a different movement per pattern.
 * `pattern="auto"` picks one at random and, with `cycle`, morphs to another every few seconds.
 */
export const DOT_PATTERNS = {
  hop: 3, // three dots hopping in turn
  swap: 3, // outer dots trade places over the middle one
  orbit: 4, // four dots circling a centre
  quad: 4, // 2×2 grid, diagonal pulse
  wave: 5, // five dots riding a sine wave
  equalizer: 5, // five pills bouncing like an equalizer
  zip: 5, // five dots zipping left → right, comet style
} as const;
export type DotPattern = keyof typeof DOT_PATTERNS;
const NAMES = Object.keys(DOT_PATTERNS) as DotPattern[];
const pick = (not?: DotPattern) => { const l = NAMES.filter((n) => n !== not); return l[Math.floor(Math.random() * l.length)]!; };

export function Dots({ pattern = "auto", cycle = false, size = 6, count, title, className = "" }: {
  pattern?: DotPattern | "auto"; cycle?: boolean; size?: number; count?: number; title?: string; className?: string;
}) {
  const [auto, setAuto] = useState<DotPattern>(() => pick());
  useEffect(() => {
    if (pattern !== "auto" || !cycle) return;
    const t = setInterval(() => setAuto((p) => pick(p)), 4200);
    return () => clearInterval(t);
  }, [pattern, cycle]);
  const p = pattern === "auto" ? auto : pattern;
  const n = DOT_PATTERNS[p];
  return (
    <span key={p} className={`dots dots-${p} ${className}`} style={{ "--d": `${size}px`, "--n": n } as CSSProperties} title={title} role="status" aria-label={title ?? "Working"}>
      {Array.from({ length: n }, (_, i) => <i key={i} style={{ "--i": i } as CSSProperties} />)}
      {count && count > 1 ? <b>{count}</b> : null}
    </span>
  );
}
