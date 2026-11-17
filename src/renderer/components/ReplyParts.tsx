import { briefHeadline, replyParts, type DelegationPart, type ResultPart } from "@shared/replyParts";
import { roleOf } from "../store";
import { Markdown } from "./Markdown";
import { useKeptState } from "./virtual";
import { Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleHelp, CircleX, CornerDownRight, RoleIcon } from "./icons";

/**
 * An agent's prose, made easy to scan: text-mode delegations and new agents as one-line cards (brief one click away),
 * the <result> block as a status card, and a trailing "Details" section folded.
 */
export function ReplyText({ text, id }: { text: string; id: string }) {
  const parts = replyParts(text);
  return <>{parts.map((p, i) => {
    const k = `${id}:${i}`;
    switch (p.kind) {
      case "md": return <Markdown key={k} text={p.text} />;
      case "delegations": return <Delegations key={k} id={k} items={p.items} />;
      case "agent": return <Expandable key={k} id={k} icon={<Bot size={14} />} label={<><b>New agent</b> {p.name}</>} line={p.description} body={p.instructions} />;
      case "result": return <ResultCard key={k} r={p.result} />;
      case "details": return <Details key={k} id={k} title={p.title} text={p.text} />;
    }
  })}</>;
}

function Delegations({ id, items }: { id: string; items: DelegationPart[] }) {
  return (
    <div className="deleg-group">
      <div className="deleg-head"><CornerDownRight size={13} /> Delegated to {items.length === 1 ? "1 specialist" : `${items.length} specialists`}</div>
      {items.map((d, i) => {
        const role = roleOf(d.role);
        return <Expandable key={i} id={`${id}:${i}`} icon={<RoleIcon role={d.role} size={16} />}
          label={<><b>{role?.title ?? d.role}</b>{d.harness && <span className="muted"> on {d.harness}</span>}</>} line={briefHeadline(d.brief)} body={d.brief} />;
      })}
    </div>
  );
}

/** One line (icon, label, headline); click to read the whole text. */
function Expandable({ id, icon, label, line, body }: { id: string; icon: React.ReactNode; label: React.ReactNode; line: string; body: string }) {
  const [open, setOpen] = useKeptState(`xp:${id}`, false);
  const more = body.trim() !== line.trim();
  return (
    <div className={`deleg ${open ? "open" : ""}`}>
      <button type="button" className="deleg-row" onClick={() => more && setOpen((o) => !o)} aria-expanded={open} disabled={!more}>
        {icon}<span className="deleg-label">{label}</span><span className="deleg-line">{line}</span>
        {more && (open ? <ChevronDown size={13} className="deleg-chev" /> : <ChevronRight size={13} className="deleg-chev" />)}
      </button>
      {open && <div className="deleg-body"><Markdown text={body} /></div>}
    </div>
  );
}

const STATUS: Record<string, { label: string; cls: string; icon: typeof CircleCheck }> = {
  done: { label: "Done", cls: "ok", icon: CircleCheck },
  needs_decision: { label: "Needs your decision", cls: "ask", icon: CircleHelp },
  blocked: { label: "Blocked", cls: "warn", icon: CircleAlert },
  failed: { label: "Failed", cls: "bad", icon: CircleX },
};

/** The specialist's <result> block: status and summary up front, findings as a short list underneath. */
function ResultCard({ r }: { r: ResultPart }) {
  const st = STATUS[r.status] ?? STATUS.done!;
  const I = st.icon;
  return (
    <div className={`result-card ${st.cls}`}>
      <div className="result-head"><I size={14} /><span className="result-status">{st.label}</span>{r.summary && <span className="result-summary"><Markdown text={r.summary} /></span>}</div>
      {r.question && <div className="result-question"><Markdown text={r.question} /></div>}
      {r.findings.length > 0 && <ul className="result-findings">{r.findings.map((f, i) => <li key={i}><Markdown text={f} /></li>)}</ul>}
      {r.artifacts.length > 0 && <div className="result-arts">{r.artifacts.map((a) => <code key={a} className="inline-code">{a}</code>)}</div>}
    </div>
  );
}

function Details({ id, title, text }: { id: string; title: string; text: string }) {
  const [open, setOpen] = useKeptState(`details:${id}`, false);
  return (
    <div className={`reply-details ${open ? "open" : ""}`}>
      <button type="button" className="reply-details-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{title}
      </button>
      {open && <div className="reply-details-body"><Markdown text={text} /></div>}
    </div>
  );
}
