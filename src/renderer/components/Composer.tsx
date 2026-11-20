import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Chat, DriveMode, DuoMode } from "@shared/types";
import { DRIVE_MODES } from "@shared/types";
import { chatOnDuo, DUO_DIAL, duoDialTurn, modeClickPatch } from "@shared/settings";
import type { ReactNode } from "react";
import { api, useStore } from "../store";
import { draftKey, drafts } from "../drafts";
import { canBrowse, sentHistory, stepHistory } from "../history";
import { applyToken, BUILTIN_COMMANDS, insertTrigger, tokenAt } from "@shared/inline-commands";
import { RoleIcon, ArrowUp, AtSign, File, Flag, Home, Hourglass, Leaf, Paperclip, Plane, RotateCcw, Settings, Slash, Sofa, Sparkles, CornerDownRight, X } from "./icons";

const MODE_META: Record<DriveMode, { label: string; icon: ReactNode; hint: string }> = {
  local: { label: "LOCAL", icon: <Home size={13} />, hint: "On-prem / local model" },
  eco: { label: "ECO", icon: <Leaf size={13} />, hint: "Cheapest capable model" },
  comfort: { label: "COMFORT", icon: <Sofa size={13} />, hint: "Balanced quality and cost" },
  sport: { label: "SPORT", icon: <Flag size={13} />, hint: "Most capable model" },
};

const toBase64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] ?? "");
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});

type ComposerProps = { chat: Chat; parentId: string | null; placeholder: string; busy: boolean; compact?: boolean };

/** Chat input: text, attachments (attach / paste / drop), @agents, /commands, superpowers, autopilot, queue-or-steer while busy.
 *  Keyed by chat and thread so each one keeps its own draft. */
export function Composer(props: ComposerProps) {
  return <ComposerBox key={draftKey(props.chat.id, props.parentId)} {...props} />;
}

function ComposerBox({ chat, parentId, placeholder, busy, compact }: ComposerProps) {
  const { roles, skills, toast, settings, upsertChat } = useStore();
  const key = draftKey(chat.id, parentId);
  const [text, setText] = useState(() => drafts.get(key).text);
  const [sel, setSel] = useState(0);
  const [atts, setAtts] = useState<Attachment[]>(() => drafts.get(key).attachments);
  // Up/Down browse your sent messages; while one is shown, the draft you were typing is kept aside, not overwritten.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const stash = useRef("");
  const sentMsgs = useStore((s) => (parentId ? s.threads[parentId] : s.messages[chat.id]));
  const history = useMemo(() => sentHistory(sentMsgs, parentId), [sentMsgs, parentId]);
  useEffect(() => { if (histIdx === null) drafts.set(key, { text, attachments: atts }); else drafts.set(key, { attachments: atts }); }, [key, text, atts, histIdx]);
  const browse = (dir: "up" | "down") => {
    const next = stepHistory(history, histIdx, dir);
    if (next === undefined) return false;
    if (histIdx === null) stash.current = text;
    setHistIdx(next);
    const value = next === null ? stash.current : history[next]!;
    setText(value);
    // Caret at the end, so the next Up/Down keeps browsing (and Down from a multi-line entry works).
    requestAnimationFrame(() => ta.current?.setSelectionRange(value.length, value.length));
    return true;
  };
  const [uploading, setUploading] = useState(0);
  const [whileBusy, setWhileBusy] = useState<"queue" | "steer">(settings?.chat.defaultSendWhileBusy ?? "steer");
  const [resetting, setResetting] = useState(false);
  const resetContext = async () => {
    setResetting(true);
    try { await api().resetContext(chat.id); } catch (e: any) { useStore.getState().toast("warn", String(e?.message ?? e)); }
    setTimeout(() => setResetting(false), 700);
  };
  const [dragOver, setDragOver] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  // Ctrl/Cmd+L and the command palette focus the main composer of the open chat.
  useEffect(() => {
    if (parentId) return;
    const focus = () => { ta.current?.focus(); const n = ta.current?.value.length ?? 0; ta.current?.setSelectionRange(n, n); };
    window.addEventListener("flash:focus-composer", focus);
    return () => window.removeEventListener("flash:focus-composer", focus);
  }, [parentId]);

  // The @mention or /command the caret is in, anywhere in the message (start of text or after whitespace).
  const [caret, setCaret] = useState(() => text.length);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const token = useMemo(() => { const t = tokenAt(text, caret); return t && t.start !== dismissed ? t : null; }, [text, caret, dismissed]);
  const suggestions = useMemo(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    if (token.kind === "@") return roles.filter((r) => r.name.startsWith(q)).map((r) => ({ insert: `@${r.name} `, label: <span className="row gap-s"><RoleIcon role={r.name} size={18} /> @{r.name}</span>, hint: r.title }));
    const cmds = [...BUILTIN_COMMANDS, ...skills.filter((s) => s.command !== "superpowers-index").map((s) => ({ c: s.command, d: s.description }))];
    return cmds.filter((x) => x.c.startsWith(q)).map((x) => ({ insert: `/${x.c} `, label: <span>/{x.c}</span>, hint: x.d }));
  }, [token, roles, skills]);
  const putText = (next: { text: string; caret: number }) => {
    setText(next.text); setCaret(next.caret); setSel(0); setHistIdx(null);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(next.caret, next.caret); });
  };
  const pick = (insert: string) => { if (token) putText(applyToken(text, token, insert)); };
  const trigger = (ch: "@" | "/") => { const t = ta.current; setDismissed(null); putText(insertTrigger(text, t?.selectionStart ?? text.length, t?.selectionEnd ?? text.length, ch)); };

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      setUploading((n) => n + 1);
      try {
        const a = await api().saveAttachment({ chatId: chat.id, name: f.name || `pasted-${Date.now()}.png`, mime: f.type, dataBase64: await toBase64(f) });
        setAtts((x) => [...x, a]);
      } catch (e: any) { toast("error", String(e?.message ?? e)); } finally { setUploading((n) => n - 1); }
    }
  };
  const patchChat = async (p: Partial<Chat>) => upsertChat(await api().updateChat(chat.id, p));

  const send = async (mode?: "queue" | "steer") => {
    const content = text.trim();
    if (!content && !atts.length) return;
    const sending = atts;
    // Sending a message recalled from history brings back the draft you had set aside.
    setText(histIdx !== null ? stash.current : "");
    setHistIdx(null);
    setAtts([]);
    try {
      await api().sendMessage({ chatId: chat.id, content: content || "(see attachments)", parentId, attachments: sending, whileBusy: mode ?? whileBusy });
    } catch (e: any) {
      toast("error", String(e?.message ?? e));
      setText(content);
      setAtts(sending);
    }
  };
  const draftTokens = Math.ceil(text.length / 4);
  const duo = !!settings?.duo?.modes && chatOnDuo(chat, settings);
  // On Duo the Duo strip replaces the drive modes, so a drive mode left over from before Duo is dropped rather than
  // steering the chat while hidden (one with its own harness would move the coordinator off Duo).
  useEffect(() => { if (!compact && duo && chat.mode) void patchChat({ mode: null }).catch(() => undefined); }, [compact, duo, chat.mode]);

  return (
    <div className={`composer-wrap ${compact ? "compact" : ""}`}>
      <div className={`composer2 ${dragOver ? "drag" : ""}`}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === "file")) { e.preventDefault(); e.stopPropagation(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); void addFiles([...e.dataTransfer.files]); }}>
        {suggestions.length > 0 && (
          <div className="suggest">
            {suggestions.map((s, i) => (
              <button key={s.insert} className={i === sel ? "sel" : ""} onMouseDown={(e) => { e.preventDefault(); pick(s.insert); }}>
                <span>{s.label}</span><span className="muted small">{s.hint}</span>
              </button>
            ))}
          </div>
        )}
        {(atts.length > 0 || uploading > 0) && (
          <div className="att-row">
            {atts.map((a) => (
              <span key={a.id} className="att-chip" title={`${a.name} · ${(a.size / 1024).toFixed(0)} KB`}>
                {a.thumb ? <img src={a.thumb} alt="" /> : <span className="att-icon"><File size={18} /></span>}
                <span className="att-name">{a.name}</span>
                <button onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))} title="Remove"><X size={12} /></button>
              </span>
            ))}
            {uploading > 0 && <span className="muted small">Uploading {uploading}…</span>}
          </div>
        )}
        <textarea ref={ta} value={text} placeholder={busy ? (whileBusy === "steer" ? "Steer the running agent… (Enter)" : "Queue a message for when the agent finishes… (Enter)") : placeholder}
          rows={Math.min(10, Math.max(compact ? 2 : 3, text.split("\n").length))}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setDismissed(null); setSel(0); setHistIdx(null); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void addFiles(files); } }}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) { e.preventDefault(); pick(suggestions[sel]!.insert); return; }
            if (suggestions.length && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(token?.start ?? null); return; }
            if (suggestions.length && e.key === "ArrowDown") { e.preventDefault(); setSel((sel + 1) % suggestions.length); return; }
            if (suggestions.length && e.key === "ArrowUp") { e.preventDefault(); setSel((sel - 1 + suggestions.length) % suggestions.length); return; }
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              const dir = e.key === "ArrowUp" ? "up" : "down";
              const t = e.currentTarget;
              if (canBrowse(dir, t.value, t.selectionStart, t.selectionEnd) && browse(dir)) { e.preventDefault(); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }} />
        <div className="composer-bar">
          {/* Every control in this row shares the drive strip's slanted, automotive look (ds-seg). */}
          <div className="ds-segs cb-group">
            <button className="ds-seg cb-btn" title="Attach files or images (you can also paste or drop them)" aria-label="Attach files"
              onClick={async () => setAtts([...atts, ...(await api().pickAttachments(chat.id))])}><span><Paperclip size={14} /></span></button>
            <button className="ds-seg cb-btn" title="Route to a specialist" aria-label="Route to a specialist" onClick={() => trigger("@")}><span><AtSign size={14} /></span></button>
            <button className="ds-seg cb-btn" title="Commands and workflows" aria-label="Commands and workflows" onClick={() => trigger("/")}><span><Slash size={13} /></span></button>
          </div>
          {!compact && (
            <div className="ds-segs cb-group">
              <button className={`ds-seg cb-toggle superpowers ${chat.superpowers ? "on" : ""}`} aria-pressed={chat.superpowers}
                title="Superpowers workflow (brainstorm → plan → TDD → review → verify), on demand" onClick={() => patchChat({ superpowers: !chat.superpowers })}>
                {chat.superpowers && <i className="ds-glint" />}<span><Sparkles size={13} /> <span className="cb-label">Superpowers</span></span></button>
              <button className={`ds-seg cb-toggle autopilot ${chat.autopilot ? "on" : ""}`} aria-pressed={chat.autopilot}
                title="Autopilot: approve all tool calls automatically and let agents work without asking for feedback (blocked commands and read-only mode still apply)"
                onClick={() => patchChat({ autopilot: !chat.autopilot })}>
                {chat.autopilot && <i className="ds-glint" />}<span><Plane size={13} className="autopilot-plane" /> <span className="cb-label">Autopilot</span></span></button>
              <button className={`ds-seg cb-btn reset-ctx ${resetting ? "spin" : ""}`} disabled={busy} aria-label="Reset context"
                title={busy ? "Stop the running agent to reset the context" : "Reset context — agents in this chat start fresh (messages stay visible)"}
                onClick={resetContext}><span><RotateCcw size={13} /></span></button>
            </div>
          )}
          {busy && (
            <div className="ds-segs cb-group cb-busy" role="radiogroup" title="What sending does while the agent is still working">
              <button className={`ds-seg cb-toggle ${whileBusy === "steer" ? "on" : ""}`} role="radio" aria-checked={whileBusy === "steer"} title="Steer: Enter sends to the running agent now" onClick={() => setWhileBusy("steer")}>
                <span><CornerDownRight size={12} /> <span className="cb-label">Steer</span></span></button>
              <button className={`ds-seg cb-toggle ${whileBusy === "queue" ? "on" : ""}`} role="radio" aria-checked={whileBusy === "queue"} title="Queue: Enter sends when the agent finishes" onClick={() => setWhileBusy("queue")}>
                <span><Hourglass size={12} /> <span className="cb-label">Queue</span></span></button>
            </div>
          )}
          <span className="grow" />
          {text && <span className="muted small" title="Estimated tokens of this message">~{draftTokens} tok</span>}
          <div className="cb-drive">
          {/* One drive selector beside Send: Duo's strip while the chat runs on Duo, else the drive modes. */}
          {!compact && settings && !duo && <ModeBar chat={chat} onChange={(mode) => patchChat(modeClickPatch(chat, settings, { mode }))} />}
          {!compact && settings && <DuoStrip chat={chat} onChange={(duoMode) => patchChat(modeClickPatch(chat, settings, { duoMode }))} />}
          <button className="primary send" onClick={() => send()} disabled={!text.trim() && !atts.length}
            title={busy ? (whileBusy === "steer" ? "Steer the running agent (Enter)" : "Queue for when the agent finishes (Enter)") : "Send (Enter)"}
            aria-label={busy ? (whileBusy === "steer" ? "Steer" : "Queue") : "Send"}>
            <span>{busy ? (whileBusy === "steer" ? <CornerDownRight size={15} strokeWidth={2.2} /> : <Hourglass size={14} strokeWidth={2.2} />) : <ArrowUp size={16} strokeWidth={2.4} />}</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Drive modes beside Send, as the same slanted strip as Duo's (LOCAL, ECO, COMFORT, SPORT): each switches the chat's
 * model profile (Settings → Modes). Click the lit mode again to go back to the chat's own model; arrow keys step along.
 */
function ModeBar({ chat, onChange }: { chat: Chat; onChange: (m: DriveMode | null) => void }) {
  const st = useStore();
  const modes = st.settings?.modes;
  const strip = useRef<HTMLDivElement>(null);
  if (!modes) return null;
  const cur = chat.mode ?? null;
  const usable = DRIVE_MODES.filter((m) => !!modes[m].model || m !== "local");
  const idx = cur ? DRIVE_MODES.indexOf(cur) : -1;
  const lit = idx < 0 ? 0 : [2, 3, 5, 7][idx]!;
  return (
    <div ref={strip} className={`duo-strip drive-strip ds-${cur ?? "off"}`} role="radiogroup" aria-label="Drive mode"
      title="Drive modes switch the model profile for this chat (configure them in Settings → Modes). Click the lit mode again to go back to the chat's own model."
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
        if (!step || !usable.length) return;
        e.preventDefault();
        const at = cur ? usable.indexOf(cur) : step > 0 ? -1 : usable.length;
        const next = usable[Math.max(0, Math.min(usable.length - 1, at + step))]!;
        if (next !== cur) onChange(next);
        strip.current?.querySelectorAll<HTMLButtonElement>(".ds-seg")[DRIVE_MODES.indexOf(next)]?.focus();
      }}>
      <div className="ds-segs">
        {DRIVE_MODES.map((m, i) => {
          const p = modes[m];
          const configured = !!p.model || m !== "local";
          const meta = MODE_META[m];
          const on = cur === m;
          return (
            <button key={m} className={`ds-seg ds-${m} ${on ? "on" : ""}`} role="radio" aria-checked={on} disabled={!configured}
              tabIndex={on || (!cur && m === usable[0]) ? 0 : -1}
              title={configured ? `${meta.label}: ${meta.hint} · ${p.harness || "chat harness"} · ${p.model || "default model"}${p.thinking ? ` · ${p.thinking} thinking` : ""}${on ? " (click again for the chat's own model)" : ""}` : "Configure LOCAL in Settings → Modes"}
              onClick={() => onChange(on ? null : m)}>
              {on && <i key={m} className="ds-glint" />}
              <span>{i > 0 && <span className="ds-chev">{Array.from({ length: i }, (_, k) => <i key={k} />)}</span>}<span className="ds-full">{meta.label}</span><span className="ds-short">{meta.label[0]}</span></span>
            </button>
          );
        })}
      </div>
      <span className="ds-rev" aria-hidden>{Array.from({ length: 7 }, (_, k) => <i key={k} className={k < lit ? "lit" : ""} style={{ height: 5 + k }} />)}</span>
      <button className="ds-gear" title="Configure modes" onClick={() => st.setView({ kind: "settings", tab: "modes" })}><Settings size={12} /></button>
    </div>
  );
}

/**
 * GitLab Duo's drive modes, beside Send while the chat runs on Duo: a slanted strip, like a sports car's mode selector,
 * with AUTO (Duo's usual model), ECO, COMFORT and SPORT. Each sets the model and thinking level of the chat's Duo agents
 * (Settings → Harnesses → GitLab Duo). Click a mode (click the lit one again for AUTO); the scroll wheel and arrow keys
 * step along the strip. Chevrons and the rev bar grow with power, and a glint runs across the mode you pick.
 */
function DuoStrip({ chat, onChange }: { chat: Chat; onChange: (m: DuoMode | null) => void }) {
  const st = useStore();
  const s = st.settings;
  const strip = useRef<HTMLDivElement>(null);
  const wheel = useRef(0);
  const cur = chat.duoMode ?? null;
  const shown = !!s?.duo?.modes && chatOnDuo(chat, s);
  const turn = useRef(onChange);
  turn.current = (m) => { if (m !== cur) onChange(m); };
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    // A native listener, so the wheel steps the modes instead of scrolling the chat.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel.current += e.deltaY;
      if (Math.abs(wheel.current) < 40) return;
      turn.current(duoDialTurn(cur, wheel.current < 0 ? 1 : -1));
      wheel.current = 0;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [shown, cur]);
  if (!shown || !s) return null;
  const label = (m: DuoMode | null) => (m ? MODE_META[m].label : "AUTO");
  const model = (m: DuoMode | null) => {
    if (!m) return "Duo's usual model";
    const p = s.duo.modes[m];
    return `${p.model || "Duo's default model"}${p.thinking ? ` · ${p.thinking} thinking` : ""}`;
  };
  const idx = Math.max(0, DUO_DIAL.indexOf(cur));
  const lit = [1, 3, 5, 7][idx]!;
  return (
    <div ref={strip} className={`duo-strip ds-${cur ?? "auto"}`} role="radiogroup"
      aria-label="GitLab Duo drive mode" title="GitLab Duo drive mode: model and thinking for this chat's Duo agents. Scroll or use the arrow keys to change it."
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = duoDialTurn(cur, step);
        turn.current(next);
        (strip.current?.querySelectorAll<HTMLButtonElement>(".ds-seg")[DUO_DIAL.indexOf(next)])?.focus();
      }}>
      <span className="ds-duo" aria-hidden />
      <div className="ds-segs">
        {DUO_DIAL.map((m, i) => {
          const on = i === idx;
          return (
            <button key={m ?? "auto"} className={`ds-seg ds-${m ?? "auto"} ${on ? "on" : ""}`} role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
              title={`${label(m)}: ${m ? MODE_META[m].hint : "Duo picks"} · ${model(m)}${on && m ? " (click again for AUTO)" : ""}`}
              onClick={() => turn.current(on ? null : m)}>
              {on && <i key={m ?? "auto"} className="ds-glint" />}
              <span>{i > 0 && <span className="ds-chev">{Array.from({ length: i }, (_, k) => <i key={k} />)}</span>}<span className="ds-full">{label(m)}</span><span className="ds-short">{label(m)[0]}</span></span>
            </button>
          );
        })}
      </div>
      <span className="ds-rev" aria-hidden>{Array.from({ length: 7 }, (_, k) => <i key={k} className={k < lit ? "lit" : ""} style={{ height: 5 + k }} />)}</span>
      <button className="ds-gear" title="Configure Duo modes" onClick={() => st.setView({ kind: "settings", tab: "harnesses" })}><Settings size={12} /></button>
    </div>
  );
}
