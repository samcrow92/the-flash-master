import { useMemo, useRef, useState } from "react";
import type { Attachment, Chat, DriveMode } from "@shared/types";
import { DRIVE_MODES } from "@shared/types";
import type { ReactNode } from "react";
import { api, useStore } from "../store";
import { RoleIcon, AtSign, File, Flag, Home, Hourglass, Leaf, Paperclip, Plane, RotateCcw, Send, Settings, Slash, Sofa, Sparkles, CornerDownRight, X } from "./icons";

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

/** Chat input: text, attachments (attach / paste / drop), @agents, /commands, superpowers, autopilot, queue-or-steer while busy. */
export function Composer({ chat, parentId, placeholder, busy, compact }: { chat: Chat; parentId: string | null; placeholder: string; busy: boolean; compact?: boolean }) {
  const { roles, skills, toast, settings, upsertChat } = useStore();
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [atts, setAtts] = useState<Attachment[]>([]);
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

  const suggestions = useMemo(() => {
    const at = /^@([\w-]*)$/.exec(text);
    if (at) return roles.filter((r) => r.name.startsWith(at[1]!.toLowerCase())).map((r) => ({ insert: `@${r.name} `, label: <span className="row gap-s"><RoleIcon role={r.name} size={18} /> @{r.name}</span>, hint: r.title }));
    const sl = /^\/([\w-]*)$/.exec(text);
    if (sl) {
      const cmds = [
        { c: "superpowers", d: "toggle the superpowers workflow for this chat" }, { c: "stop", d: "stop agents in this chat" }, { c: "help", d: "list commands and specialists" },
        ...skills.filter((s) => s.command !== "superpowers-index").map((s) => ({ c: s.command, d: s.description })),
      ];
      return cmds.filter((x) => x.c.startsWith(sl[1]!.toLowerCase())).map((x) => ({ insert: `/${x.c} `, label: <span>/{x.c}</span>, hint: x.d }));
    }
    return [];
  }, [text, roles, skills]);

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
    setText("");
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

  return (
    <div className={`composer-wrap ${compact ? "compact" : ""}`}>
      <div className={`composer2 ${dragOver ? "drag" : ""}`}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === "file")) { e.preventDefault(); e.stopPropagation(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); void addFiles([...e.dataTransfer.files]); }}>
        {suggestions.length > 0 && (
          <div className="suggest">
            {suggestions.map((s, i) => (
              <button key={s.insert} className={i === sel ? "sel" : ""} onMouseDown={(e) => { e.preventDefault(); setText(s.insert); ta.current?.focus(); }}>
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
          onChange={(e) => { setText(e.target.value); setSel(0); }}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void addFiles(files); } }}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) { e.preventDefault(); setText(suggestions[sel]!.insert); return; }
            if (suggestions.length && e.key === "ArrowDown") { e.preventDefault(); setSel((sel + 1) % suggestions.length); return; }
            if (suggestions.length && e.key === "ArrowUp") { e.preventDefault(); setSel((sel - 1 + suggestions.length) % suggestions.length); return; }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }} />
        <div className="composer-bar">
          <button className="cb-btn" title="Attach files or images (you can also paste or drop them)" onClick={async () => setAtts([...atts, ...(await api().pickAttachments(chat.id))])}><Paperclip size={16} /></button>
          <button className="cb-btn" title="Route to a specialist" onClick={() => { setText((t) => (t.startsWith("@") ? t : `@${t}`)); ta.current?.focus(); }}><AtSign size={16} /></button>
          <button className="cb-btn" title="Commands and workflows" onClick={() => { setText((t) => (t.startsWith("/") ? t : `/${t}`)); ta.current?.focus(); }}><Slash size={15} /></button>
          {!compact && <>
            <span className="cb-sep" />
            <button className={`cb-toggle ${chat.superpowers ? "on" : ""}`} title="Superpowers workflow (brainstorm → plan → TDD → review → verify), on demand" onClick={() => patchChat({ superpowers: !chat.superpowers })}><Sparkles size={14} /> Superpowers</button>
            <button className={`cb-toggle autopilot ${chat.autopilot ? "on" : ""}`} title="Autopilot: approve all tool calls automatically and let agents work without asking for feedback (blocked commands and read-only mode still apply)"
              onClick={() => patchChat({ autopilot: !chat.autopilot })}><Plane size={14} className="autopilot-plane" /> Autopilot {chat.autopilot ? "on" : "off"}</button>
          </>}
          {!compact && <button className={`cb-btn reset-ctx ${resetting ? "spin" : ""}`} disabled={busy}
            title={busy ? "Stop the running agent to reset the context" : "Reset context — agents in this chat start fresh (messages stay visible)"}
            onClick={resetContext}><RotateCcw size={15} /></button>}
          {busy && (
            <div className="seg small-seg" title="What sending does while the agent is still working">
              <button className={whileBusy === "steer" ? "on" : ""} onClick={() => setWhileBusy("steer")}><CornerDownRight size={13} /> Steer</button>
              <button className={whileBusy === "queue" ? "on" : ""} onClick={() => setWhileBusy("queue")}><Hourglass size={13} /> Queue</button>
            </div>
          )}
          <span className="grow" />
          {text && <span className="muted small" title="Estimated tokens of this message">~{draftTokens} tok</span>}
          <button className="primary send" onClick={() => send()} disabled={!text.trim() && !atts.length}>{busy ? (whileBusy === "steer" ? <>Steer <CornerDownRight size={14} /></> : <>Queue <Hourglass size={14} /></>) : <>Send <Send size={14} /></>}</button>
        </div>
      </div>
      {!compact && <ModeBar chat={chat} onChange={(mode) => patchChat({ mode })} />}
    </div>
  );
}

function ModeBar({ chat, onChange }: { chat: Chat; onChange: (m: DriveMode | null) => void }) {
  const st = useStore();
  const modes = st.settings?.modes;
  if (!modes) return null;
  return (
    <div className="mode-bar" title="Drive modes switch the model profile for this chat (configure them in Settings → Modes). Click the active mode again to go back to the chat's own model.">
      {DRIVE_MODES.map((m) => {
        const p = modes[m];
        const configured = !!p.model || m !== "local";
        const meta = MODE_META[m];
        return (
          <button key={m} className={`mode-btn mode-${m} ${chat.mode === m ? "on" : ""}`} disabled={!configured}
            title={configured ? `${meta.hint}: ${p.harness || "chat harness"} · ${p.model || "default model"}${p.thinking ? ` · ${p.thinking} thinking` : ""}` : "Configure LOCAL in Settings → Modes"}
            onClick={() => onChange(chat.mode === m ? null : m)}>
            <span className="mode-label">{meta.icon} {meta.label}</span>
            <span className="mode-model">{configured ? `${p.model || "default"}${p.thinking ? ` · ${p.thinking}` : ""}` : "not set"}</span>
          </button>
        );
      })}
      <button className="mode-gear" title="Configure modes" onClick={() => st.setView({ kind: "settings", tab: "modes" })}><Settings size={15} /></button>
    </div>
  );
}
