import { Fragment, useMemo, type ReactNode } from "react";
import { diffLines, wordDiff, type DiffOp } from "@shared/diff";

type Row = { kind: "eq" | "add" | "del" | "mod"; a?: DiffOp; b?: DiffOp };

/** Pair removed/added runs inside a hunk so split view and word highlights line up. */
function pairOps(ops: DiffOp[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < ops.length;) {
    const o = ops[i]!;
    if (o.t === "eq") { rows.push({ kind: "eq", a: o, b: o }); i++; continue; }
    const dels: DiffOp[] = [], adds: DiffOp[] = [];
    while (i < ops.length && ops[i]!.t === "del") dels.push(ops[i++]!);
    while (i < ops.length && ops[i]!.t === "add") adds.push(ops[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const a = dels[k], b = adds[k];
      rows.push({ kind: a && b ? "mod" : a ? "del" : "add", a, b });
    }
  }
  return rows;
}

const Words = ({ parts, cls }: { parts: [string, boolean][]; cls: string }) => <>{parts.map(([t, c], i) => c ? <mark key={i} className={cls}>{t}</mark> : <Fragment key={i}>{t}</Fragment>)}</>;

export type DiffSide = "old" | "new";

/**
 * `onLine` + `after` (unified mode): line numbers become buttons to comment on a line, and `after` renders below a line
 * (the Review page's line comments). A removed line is addressed on the "old" side, every other line on the "new" side.
 */
export function DiffView({ oldText, newText, mode = "split", wrap = false, full = false, onLine, after }: { oldText: string; newText: string; mode?: "split" | "unified"; wrap?: boolean; full?: boolean;
  onLine?: (side: DiffSide, line: number, code: string) => void; after?: (side: DiffSide, line: number) => ReactNode }) {
  const d = useMemo(() => diffLines(oldText, newText, full ? 1e9 : 3), [oldText, newText, full]);
  if (d.identical) return <div className="diff-empty muted">No differences.</div>;
  const lastA = oldText.split("\n").length;
  return (
    <div className={`diff ${mode} ${wrap ? "wrap" : ""}`}>
      {d.truncated && <div className="warn-note small">Very large change — shown as a full replacement.</div>}
      {d.hunks.map((h, hi) => {
        const prevEnd = hi === 0 ? 0 : (d.hunks[hi - 1]!.aStart + d.hunks[hi - 1]!.aLen - 1);
        const gap = h.aStart - prevEnd - 1;
        const rows = pairOps(h.ops);
        return (
          <Fragment key={hi}>
            {gap > 0 && <div className="diff-gap">⋯ {gap} unchanged line{gap === 1 ? "" : "s"}</div>}
            {mode === "unified" ? (
              <table className="diff-table"><tbody>
                {rows.flatMap((r, i) => {
                  // A line number that opens a comment box (Review page); plain text elsewhere.
                  const num = (side: DiffSide, n: number | undefined, code: string) => n === undefined ? null
                    : onLine ? <button className="ln-btn" title="Comment on this line" onClick={() => onLine(side, n, code)}>{n}</button> : n;
                  const extra = (key: string, side: DiffSide, n: number | undefined) => {
                    const node = after && n !== undefined ? after(side, n) : null;
                    return node ? [<tr key={key} className="diff-note-row"><td colSpan={4}>{node}</td></tr>] : [];
                  };
                  if (r.kind === "eq") return [<tr key={i} className="eq"><td className="ln">{r.a!.a}</td><td className="ln">{num("new", r.b!.b, r.b!.text)}</td><td className="sg" /><td className="code">{r.a!.text || " "}</td></tr>,
                    ...extra(`${i}n`, "new", r.b!.b)];
                  const w = r.kind === "mod" ? wordDiff(r.a!.text, r.b!.text) : null;
                  const out = [];
                  if (r.a) out.push(<tr key={`${i}a`} className="del"><td className="ln">{num("old", r.a.a, r.a.text)}</td><td className="ln" /><td className="sg">−</td><td className="code">{w ? <Words parts={w.a} cls="wd" /> : r.a.text || " "}</td></tr>,
                    ...extra(`${i}an`, "old", r.a.a));
                  if (r.b) out.push(<tr key={`${i}b`} className="add"><td className="ln" /><td className="ln">{num("new", r.b.b, r.b.text)}</td><td className="sg">+</td><td className="code">{w ? <Words parts={w.b} cls="wa" /> : r.b.text || " "}</td></tr>,
                    ...extra(`${i}bn`, "new", r.b.b));
                  return out;
                })}
              </tbody></table>
            ) : (
              <table className="diff-table split"><tbody>
                {rows.map((r, i) => {
                  const w = r.kind === "mod" ? wordDiff(r.a!.text, r.b!.text) : null;
                  return (
                    <tr key={i} className={r.kind}>
                      <td className="ln">{r.a?.a ?? ""}</td>
                      <td className={`code left ${r.a && r.kind !== "eq" ? "del" : ""} ${!r.a ? "none" : ""}`}>{r.a ? (w ? <Words parts={w.a} cls="wd" /> : r.a.text || " ") : ""}</td>
                      <td className="ln">{r.b?.b ?? ""}</td>
                      <td className={`code right ${r.b && r.kind !== "eq" ? "add" : ""} ${!r.b ? "none" : ""}`}>{r.b ? (w ? <Words parts={w.b} cls="wa" /> : r.b.text || " ") : ""}</td>
                    </tr>
                  );
                })}
              </tbody></table>
            )}
          </Fragment>
        );
      })}
      {(() => {
        const last = d.hunks[d.hunks.length - 1]!;
        const rest = lastA - (last.aStart + last.aLen - 1) - 1;
        return rest > 0 ? <div className="diff-gap">⋯ {rest} unchanged line{rest === 1 ? "" : "s"}</div> : null;
      })()}
    </div>
  );
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  const total = Math.max(1, added + removed);
  const blocks = 5, g = Math.round((added / total) * blocks), r = Math.min(blocks - g, Math.round((removed / total) * blocks));
  return (
    <span className="diffstat">
      <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
      <span className="blocks">{Array.from({ length: blocks }, (_, i) => <i key={i} className={i < g ? "g" : i < g + r ? "r" : ""} />)}</span>
    </span>
  );
}
