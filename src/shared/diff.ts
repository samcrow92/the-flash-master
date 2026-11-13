/**
 * Line diff (Myers O(ND)) with hunks, unified patch output and word-level highlights for changed lines.
 * Dependency-free so it runs in the UI and in tests.
 */
export type DiffOp = { t: "eq" | "add" | "del"; a?: number; b?: number; text: string }; // a/b = 1-based line numbers
export interface Hunk { aStart: number; aLen: number; bStart: number; bLen: number; ops: DiffOp[] }
export interface DiffResult { ops: DiffOp[]; hunks: Hunk[]; added: number; removed: number; identical: boolean; truncated: boolean }

const splitLines = (s: string) => {
  if (s === "") return [];
  const l = s.replace(/\r\n/g, "\n").split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
};

/** Myers shortest edit script on arrays of lines. Falls back to a whole replace beyond `maxD` edits. */
function myers(a: string[], b: string[], maxD: number): DiffOp[] | null {
  const n = a.length, m = b.length, max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const off = max + 1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off, d);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], off: number, dEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length, y = b.length;
  for (let d = dEnd; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: "eq", a: x, b: y, text: a[x - 1]! }); x--; y--; }
    if (d === 0) break;
    if (x === prevX) { ops.push({ t: "add", b: y, text: b[y - 1]! }); y--; }
    else { ops.push({ t: "del", a: x, text: a[x - 1]! }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ t: "eq", a: x, b: y, text: a[x - 1]! }); x--; y--; }
  return ops.reverse();
}

export function diffLines(oldText: string, newText: string, context = 3): DiffResult {
  const a = splitLines(oldText), b = splitLines(newText);
  // Trim common prefix/suffix first: keeps Myers fast on large files with small edits.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  let mid = myers(am, bm, 4000);
  const truncated = !mid;
  if (!mid) mid = [...am.map((text, i) => ({ t: "del" as const, a: i + 1, text })), ...bm.map((text, i) => ({ t: "add" as const, b: i + 1, text }))];
  const ops: DiffOp[] = [
    ...a.slice(0, pre).map((text, i) => ({ t: "eq" as const, a: i + 1, b: i + 1, text })),
    ...mid.map((o) => ({ ...o, a: o.a !== undefined ? o.a + pre : undefined, b: o.b !== undefined ? o.b + pre : undefined })),
    ...a.slice(a.length - suf).map((text, i) => ({ t: "eq" as const, a: a.length - suf + i + 1, b: b.length - suf + i + 1, text })),
  ];
  const added = ops.filter((o) => o.t === "add").length, removed = ops.filter((o) => o.t === "del").length;
  return { ops, hunks: toHunks(ops, context), added, removed, identical: added === 0 && removed === 0, truncated };
}

function toHunks(ops: DiffOp[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  const changed = ops.map((o, i) => (o.t !== "eq" ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return hunks;
  let start = Math.max(0, changed[0]! - context), end = Math.min(ops.length - 1, changed[0]! + context);
  const flush = () => {
    const slice = ops.slice(start, end + 1);
    const firstA = slice.find((o) => o.a !== undefined)?.a ?? (ops.slice(0, start).reverse().find((o) => o.a !== undefined)?.a ?? 0) + 1;
    const firstB = slice.find((o) => o.b !== undefined)?.b ?? (ops.slice(0, start).reverse().find((o) => o.b !== undefined)?.b ?? 0) + 1;
    hunks.push({ aStart: firstA, aLen: slice.filter((o) => o.t !== "add").length, bStart: firstB, bLen: slice.filter((o) => o.t !== "del").length, ops: slice });
  };
  for (const i of changed.slice(1)) {
    if (i - context <= end + 1) end = Math.min(ops.length - 1, i + context);
    else { flush(); start = Math.max(0, i - context); end = Math.min(ops.length - 1, i + context); }
  }
  flush();
  return hunks;
}

/** Unified diff text (git-style headers) — what "Download patch" saves. */
export function unifiedPatch(path: string, oldText: string, newText: string, context = 3): string {
  const d = diffLines(oldText, newText, context);
  if (d.identical) return "";
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of d.hunks) {
    out.push(`@@ -${h.aLen ? h.aStart : h.aStart - 1},${h.aLen} +${h.bLen ? h.bStart : h.bStart - 1},${h.bLen} @@`);
    for (const o of h.ops) out.push((o.t === "add" ? "+" : o.t === "del" ? "-" : " ") + o.text);
  }
  return out.join("\n") + "\n";
}

/** Word-level segments for a removed/added line pair: [text, changed][] for each side. */
export function wordDiff(oldLine: string, newLine: string): { a: [string, boolean][]; b: [string, boolean][] } {
  const tok = (s: string) => s.match(/\s+|[\w$]+|[^\s\w$]/g) ?? [];
  const a = tok(oldLine), b = tok(newLine);
  if (a.length * b.length > 40000) return { a: [[oldLine, true]], b: [[newLine, true]] };
  // LCS table (lines are short)
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ra: [string, boolean][] = [], rb: [string, boolean][] = [];
  const push = (r: [string, boolean][], t: string, c: boolean) => { const last = r[r.length - 1]; if (last && last[1] === c) last[0] += t; else r.push([t, c]); };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(ra, a[i]!, false); push(rb, b[j]!, false); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push(ra, a[i++]!, true);
    else push(rb, b[j++]!, true);
  }
  while (i < a.length) push(ra, a[i++]!, true);
  while (j < b.length) push(rb, b[j++]!, true);
  return { a: ra, b: rb };
}
