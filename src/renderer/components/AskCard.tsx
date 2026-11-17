import { useState } from "react";
import type { AskCard as Ask, Message } from "@shared/types";
import { api, useStore } from "../store";
import { Markdown } from "./Markdown";
import { CircleAlert, CircleCheck, CircleHelp, CircleX, Hand, MessageCircleOff, SendHorizontal } from "./icons";

const KIND: Record<Ask["kind"], { label: string; cls: string; icon: typeof CircleHelp }> = {
  question: { label: "Question", cls: "ask", icon: CircleHelp },
  blocked: { label: "Blocked", cls: "warn", icon: CircleAlert },
  no_report: { label: "No report", cls: "warn", icon: MessageCircleOff },
  failed: { label: "Failed", cls: "bad", icon: CircleX },
  silent: { label: "No reply", cls: "warn", icon: MessageCircleOff },
};

/**
 * A "needs you" card: an agent (or the app, for a specialist that didn't deliver) waits for the user. It shows who
 * asks, the question, why it waits and quick answers; you can also type your own. The answer resumes the agent.
 */
export function AskCard({ m }: { m: Message }) {
  const ask = m.ask!;
  const k = KIND[ask.kind] ?? KIND.question;
  const I = k.icon;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    void api().answerAsk(m.id, answer.trim()).then(() => setText(""), (e) => {
      useStore.getState().toast("warn", String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }).finally(() => setBusy(false));
  };
  const answered = ask.answer;
  return (
    <div className={`ask-card ${k.cls} ${answered ? "answered" : ""}`} role="group" aria-label={`Needs you: ${ask.question}`}>
      <div className="ask-head">
        <span className="ask-flag"><Hand size={13} /> Needs you</span>
        <span className="ask-kind"><I size={13} /> {k.label}</span>
        <span className="ask-who">{ask.who}</span>
      </div>
      <div className="ask-question"><Markdown text={ask.question} /></div>
      {ask.why && <div className="ask-why"><Markdown text={ask.why} /></div>}
      {answered ? (
        <div className="ask-answer"><CircleCheck size={14} /> You answered: <b>{answered.text}</b>
          <span className="muted small"> · {new Date(answered.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
      ) : (
        <>
          {ask.options.length > 0 && (
            <div className="ask-options">
              {ask.options.map((o, i) => (
                <button key={i} type="button" className={i === ask.recommended ? "ask-opt rec" : "ask-opt"} disabled={busy} onClick={() => send(o)}
                  title={i === ask.recommended ? "Recommended" : undefined}>
                  {o}{i === ask.recommended && <span className="ask-rec">recommended</span>}
                </button>
              ))}
            </div>
          )}
          <form className="ask-reply" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
              placeholder={ask.options.length ? "Or type your own answer…" : "Type your answer…"} aria-label="Your answer" />
            <button type="submit" className="ask-send" disabled={busy || !text.trim()} title="Send answer"><SendHorizontal size={15} /><span className="sr-only">Send</span></button>
          </form>
        </>
      )}
    </div>
  );
}
