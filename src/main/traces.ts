/**
 * Local traces: every request, agent turn, tool call, delegation and checks run becomes a span in SQLite, named after
 * the OpenTelemetry GenAI semantic conventions (gen_ai.operation.name, gen_ai.agent.name, gen_ai.request.model,
 * gen_ai.usage.input_tokens, gen_ai.tool.name …). Nothing leaves the machine; a trace can be exported as OTLP/JSON for
 * any OpenTelemetry viewer. The Timeline page shows a request's spans as a waterfall.
 *
 * One trace = one request of the user to a coordinator, with everything its specialists and helpers did for it.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Span, SpanKind, SpanStatus, TraceSummary } from "@shared/types";

export type { Span, SpanKind, SpanStatus, TraceSummary };
type Attrs = Record<string, string | number | boolean>;

export const newTraceId = () => randomBytes(16).toString("hex");
const newSpanId = () => randomBytes(8).toString("hex");

const toSpan = (r: Record<string, any>): Span => ({ id: r.id, traceId: r.trace_id, parentId: r.parent_id ?? null, agentId: r.agent_id ?? null, chatId: r.chat_id ?? null,
  kind: r.kind, name: r.name, start: Number(r.start), end: r.end === null || r.end === undefined ? null : Number(r.end), status: r.status, attrs: safeJson(r.attrs) });
function safeJson(s: string): Attrs { try { return JSON.parse(s) as Attrs; } catch { return {}; } }

export class TraceStore {
  /** `raw` is the app database (the spans table comes from migration v16). */
  constructor(private raw: DatabaseSync, private enabled: () => boolean = () => true, private now: () => number = Date.now) {}

  /** Start a span; returns its id ("" when tracing is off, which every other call ignores). */
  start(s: { traceId: string; parentId?: string | null; agentId?: string | null; chatId?: string | null; kind: SpanKind; name: string; attrs?: Attrs; at?: number }): string {
    if (!this.enabled()) return "";
    const id = newSpanId();
    this.raw.prepare("INSERT INTO spans(id, trace_id, parent_id, agent_id, chat_id, kind, name, start, end, status, attrs) VALUES(?,?,?,?,?,?,?,?,NULL,'running',?)")
      .run(id, s.traceId, s.parentId ?? null, s.agentId ?? null, s.chatId ?? null, s.kind, s.name.slice(0, 300), s.at ?? this.now(), JSON.stringify(s.attrs ?? {}));
    return id;
  }

  /** End a span (attributes are merged). Ending twice keeps the first end unless `touch` (the request span grows with each turn). */
  end(id: string | null | undefined, o: { status?: SpanStatus; attrs?: Attrs; touch?: boolean } = {}): void {
    if (!id) return;
    const r = this.raw.prepare("SELECT end, attrs, status FROM spans WHERE id=?").get(id) as { end: number | null; attrs: string; status: string } | undefined;
    if (!r || (r.end !== null && !o.touch)) return;
    const attrs = { ...safeJson(r.attrs), ...(o.attrs ?? {}) };
    this.raw.prepare("UPDATE spans SET end=?, status=?, attrs=? WHERE id=?").run(this.now(), o.status ?? (r.status === "running" ? "ok" : r.status), JSON.stringify(attrs), id);
  }

  /** Merge attributes into a span without ending it. */
  annotate(id: string | null | undefined, attrs: Attrs): void {
    if (!id) return;
    const r = this.raw.prepare("SELECT attrs FROM spans WHERE id=?").get(id) as { attrs: string } | undefined;
    if (r) this.raw.prepare("UPDATE spans SET attrs=? WHERE id=?").run(JSON.stringify({ ...safeJson(r.attrs), ...attrs }), id);
  }

  /** Rename a trace's root span and merge attributes into it (eval runs are labelled so they stand out on the Timeline). */
  labelRoot(traceId: string, name: string, attrs: Attrs = {}): void {
    const r = this.raw.prepare("SELECT id, attrs FROM spans WHERE trace_id=? AND parent_id IS NULL ORDER BY start LIMIT 1").get(traceId) as { id: string; attrs: string } | undefined;
    if (r) this.raw.prepare("UPDATE spans SET name=?, attrs=? WHERE id=?").run(name.slice(0, 300), JSON.stringify({ ...safeJson(r.attrs), ...attrs }), r.id);
  }

  spans(traceId: string): Span[] {
    return (this.raw.prepare("SELECT * FROM spans WHERE trace_id=? ORDER BY start, rowid").all(traceId) as Record<string, any>[]).map(toSpan);
  }

  /** Recent traces (newest first), optionally for one chat. */
  list(o: { chatId?: string | null; limit?: number } = {}): TraceSummary[] {
    const rows = (o.chatId
      ? this.raw.prepare("SELECT trace_id, MIN(start) AS s, MAX(COALESCE(end, start)) AS e, COUNT(*) AS n, MAX(chat_id) AS chat FROM spans WHERE chat_id=? GROUP BY trace_id ORDER BY s DESC LIMIT ?").all(o.chatId, o.limit ?? 30)
      : this.raw.prepare("SELECT trace_id, MIN(start) AS s, MAX(COALESCE(end, start)) AS e, COUNT(*) AS n, MAX(chat_id) AS chat FROM spans GROUP BY trace_id ORDER BY s DESC LIMIT ?").all(o.limit ?? 30)) as Record<string, any>[];
    return rows.map((r) => {
      const spans = this.spans(r.trace_id);
      const root = spans.find((x) => !x.parentId) ?? spans[0];
      const tokens = spans.filter((x) => x.kind === "turn").reduce((n, x) => n + Number(x.attrs["gen_ai.usage.input_tokens"] ?? 0) + Number(x.attrs["gen_ai.usage.output_tokens"] ?? 0), 0);
      return { traceId: r.trace_id, chatId: r.chat ?? null, name: root?.name ?? "", start: Number(r.s), end: Number(r.e), spans: Number(r.n), tokens,
        agents: new Set(spans.map((x) => x.agentId).filter(Boolean)).size, errors: spans.filter((x) => x.status === "error").length,
        running: spans.some((x) => x.end === null) };
    });
  }

  /** Delete traces whose newest span is older than `days`. Returns how many spans went. */
  prune(days: number): number {
    if (!days || days <= 0) return 0;
    const cutoff = this.now() - days * 86_400_000;
    const r = this.raw.prepare("DELETE FROM spans WHERE trace_id IN (SELECT trace_id FROM spans GROUP BY trace_id HAVING MAX(COALESCE(end, start)) < ?)").run(cutoff);
    return Number(r.changes ?? 0);
  }

  /** Spans left running by a crash or a quit are closed as "stopped" at startup. */
  closeDangling(): void {
    this.raw.prepare("UPDATE spans SET end=start, status='stopped' WHERE end IS NULL").run();
  }
}

/** One trace as OTLP/JSON (ExportTraceServiceRequest), for Jaeger, Grafana Tempo, Phoenix or any OpenTelemetry viewer. */
export function toOtlp(spans: Span[], service = "theflashmaster"): unknown {
  const value = (v: string | number | boolean) => typeof v === "boolean" ? { boolValue: v } : typeof v === "number"
    ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v };
  const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeSpans: [{
        scope: { name: "theflashmaster.orchestrator" },
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.id, ...(s.parentId ? { parentSpanId: s.parentId } : {}), name: s.name,
          kind: s.kind === "tool" ? 3 : 1, // CLIENT for tool calls, INTERNAL otherwise
          startTimeUnixNano: nanos(s.start), endTimeUnixNano: nanos(s.end ?? s.start),
          attributes: [{ key: "flash.span.kind", value: { stringValue: s.kind } }, ...(s.agentId ? [{ key: "flash.agent.id", value: { stringValue: s.agentId } }] : []),
            ...Object.entries(s.attrs).map(([key, v]) => ({ key, value: value(v) }))],
          status: { code: s.status === "error" ? 2 : s.status === "ok" ? 1 : 0 },
        })),
      }],
    }],
  };
}

/** Waterfall rows for the Timeline: spans in tree order with their depth (children right after their parent, by start). */
export function waterfall(spans: Span[]): { span: Span; depth: number }[] {
  const ids = new Set(spans.map((s) => s.id));
  const kids = new Map<string | null, Span[]>();
  for (const s of spans) {
    const p = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  const out: { span: Span; depth: number }[] = [];
  const walk = (p: string | null, depth: number) => {
    for (const s of (kids.get(p) ?? []).sort((a, b) => a.start - b.start)) { out.push({ span: s, depth }); if (depth < 20) walk(s.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}
