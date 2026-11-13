import { useEffect, useMemo, useRef, useState } from "react";
import type { HarnessId, Message } from "@shared/types";
import { HARNESS_IDS } from "@shared/types";
import { api, fmtTokens, roleOf, useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { FlowPanel } from "./FlowView";

const EMOJIS = ["👍", "👎", "✅", "❌", "🎉", "👀", "❤️", "🚀"];

export function ChatView({ chatId }: { chatId: string }) {
  const st = useStore();
  const chat = st.chatById[chatId];
  const messages = st.messages[chatId] ?? [];
  const project = st.projects.find((p) => p.id === chat?.projectId);
  const chatAgents = Object.values(st.agents).filter((a) => a.chatId === chatId && ["running", "paused", "idle"].includes(a.status));
  const busy = chatAgents.some((a) => a.status === "running");
  const listRef = useRef<HTMLDivElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => { listRef.current?.scrollTo({ top: 1e9 }); }, [chatId]);

  if (!chat) return <div className="empty">Chat not found.</div>;

  const update = async (patch: Partial<typeof chat>) => st.upsertChat(await api().updateChat(chatId, patch));
  const isMaster = chat.kind === "master";

  return (
    <div className={`chat-layout ${st.thread || st.flowPanel?.chatId === chatId ? "with-thread" : ""}`}>
      <section className="chat">
        <header className="chat-header">
          <div className="chat-title-block">
            {editingTitle ? (
              <input autoFocus className="title-input" defaultValue={chat.title}
                onBlur={(e) => { setEditingTitle(false); if (e.target.value.trim()) void update({ title: e.target.value.trim() }); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            ) : (
              <h2 onDoubleClick={() => !isMaster && setEditingTitle(true)} title={isMaster ? "" : "Double-click to rename"}>
                {isMaster ? "⚡ TheFlashMaster — master chat" : chat.title}
              </h2>
            )}
            <div className="muted small">{project ? project.path : isMaster ? "Coordinator across all projects" : "No project"}</div>
          </div>
          <div className="chat-controls">
            <label className="ctl" title="Default agent for this chat (override per message with @role)">
              <span>Agent</span>
              <select value={chat.agentRole} onChange={(e) => update({ agentRole: e.target.value })}>
                {st.roles.map((r) => <option key={r.name} value={r.name}>{r.icon} {r.title}</option>)}
              </select>
            </label>
            <label className="ctl" title="Harness used for new agent sessions in this chat">
              <span>Harness</span>
              <select value={chat.harness ?? ""} onChange={(e) => update({ harness: (e.target.value || null) as HarnessId | null })}>
                <option value="">auto</option>
                {HARNESS_IDS.filter((h) => h !== "mock" || st.settings?.advanced.showMockHarness).map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <label className="ctl" title="Model id passed to the harness (blank = harness default)">
              <span>Model</span>
              <input className="model-input" placeholder="default" defaultValue={chat.model ?? ""} onBlur={(e) => update({ model: e.target.value.trim() || null })} />
            </label>
            <button className={`toggle ${chat.superpowers ? "on" : ""}`} title="Superpowers workflow (off by default, on demand)"
              onClick={() => update({ superpowers: !chat.superpowers })}>⚡ Superpowers {chat.superpowers ? "on" : "off"}</button>
            <button className={st.flowPanel?.chatId === chatId ? "toggle on" : ""} title="Flow chart of where the agents are in their task"
              onClick={() => (st.flowPanel?.chatId === chatId ? useStore.setState({ flowPanel: null }) : st.openFlow(chatId, null))}>🧭 Progress</button>
            {busy && <button className="danger" onClick={() => chatAgents.forEach((a) => api().stopAgent(a.id))}>■ Stop</button>}
            {!isMaster && (
              <button className="ghost" title="Delete chat" onClick={async () => {
                if (!confirm(`Delete chat "${chat.title}"?`)) return;
                await api().deleteChat(chatId);
                st.removeChat(chat);
                if (st.masterChatId) void st.openChat(st.masterChatId);
              }}>🗑</button>
            )}
          </div>
        </header>

        {chatAgents.length > 0 && (
          <div className="agent-strip">
            {chatAgents.map((a) => (
              <span key={a.id} className={`agent-chip st-${a.status}`} title={`${a.lastActivity ?? ""}\nClick to see the progress flow`}>
                <button className="chip-main" onClick={() => st.openFlow(chatId, a.id)}>
                  {roleOf(a.role)?.icon} {roleOf(a.role)?.title ?? a.role} · {a.harness} · {a.status}
                  {a.plan.length > 0 && ` · ${a.plan.filter((p) => p.status === "completed").length}/${a.plan.length}`}
                </button>
                {a.status === "running" && <button onClick={() => api().pauseAgent(a.id)} title="Pause">⏸</button>}
                {a.status === "paused" && <button onClick={() => api().resumeAgent(a.id)} title="Resume">▶</button>}
                <button onClick={() => api().stopAgent(a.id)} title="Stop">■</button>
              </span>
            ))}
          </div>
        )}

        <div className="messages" ref={listRef}>
          {messages.length === 0 && <EmptyChat isMaster={isMaster} />}
          {messages.map((m) => <MessageItem key={m.id} m={m} onReply={() => st.openThread(chatId, m.id)} />)}
        </div>
        <Composer chatId={chatId} parentId={null} placeholder={`Message ${roleOf(chat.agentRole)?.title ?? "agent"} — @role to route, / for commands`} />
      </section>
      {st.thread && st.thread.chatId === chatId && <ThreadPanel />}
      {!st.thread && st.flowPanel?.chatId === chatId && <FlowPanel chatId={chatId} agentId={st.flowPanel.agentId} onClose={() => useStore.setState({ flowPanel: null })} />}
    </div>
  );
}

function EmptyChat({ isMaster }: { isMaster: boolean }) {
  return (
    <div className="empty-chat">
      <div className="logo-big">⚡</div>
      <h3>{isMaster ? "Coordinate your agent team" : "Start the conversation"}</h3>
      <p className="muted">
        {isMaster
          ? "Tell TheFlashMaster what you need. It plans, delegates to specialists (reviewer, architect, AUTOSAR/Vector, winIDEA debugger…) and integrates their results."
          : "Type a message. Use @reviewer, @architect, @autosar-vector… to route to a specialist, or /help for commands."}
      </p>
      <p className="muted small">Superpowers (brainstorm → plan → TDD → review → verify) is off by default — toggle it in the header or type /superpowers.</p>
    </div>
  );
}

export function MessageItem({ m, onReply, inThread }: { m: Message; onReply?: () => void; inThread?: boolean }) {
  const role = roleOf(m.role);
  const agent = useStore((s) => (m.agentId ? s.agents[m.agentId] : undefined));
  const showTokens = useStore((s) => s.settings?.tokens.showTokenCounts);
  const [picker, setPicker] = useState(false);
  const who = m.author === "user" ? "You" : m.author === "system" ? "System" : role?.title ?? m.role ?? "Agent";
  const icon = m.author === "user" ? "🧑" : m.author === "system" ? "ℹ️" : role?.icon ?? "🤖";
  const react = (e: string) => { setPicker(false); void api().toggleReaction(m.id, e); };

  return (
    <div className={`msg msg-${m.author} ${m.status === "error" ? "msg-error" : ""}`}>
      <div className="avatar">{icon}</div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="who">{who}</span>
          <span className="muted small">{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          {showTokens && (m.tokensIn > 0 || m.tokensOut > 0) && (
            <span className="tokens" title={m.estimated ? "Estimated (harness did not report usage)" : "Reported by harness"}>
              {fmtTokens(m.tokensIn)}↑ {fmtTokens(m.tokensOut)}↓{m.estimated ? " est." : ""}
            </span>
          )}
        </div>
        <div className="msg-content">
          {m.author === "user" ? <div className="plain">{m.content}</div> : <Markdown text={m.content || (m.status === "streaming" ? "" : "")} />}
          {m.status === "streaming" && (
            <div className="streaming"><span className="caret" /> <span className="muted small">{agent?.lastActivity ?? "Working…"}</span></div>
          )}
        </div>
        <div className="msg-footer">
          {m.reactions.map((r) => <button key={r} className="reaction" onClick={() => react(r)} title="Toggle reaction">{r}</button>)}
          <div className="msg-actions">
            <button onClick={() => setPicker((p) => !p)} title="React">☺</button>
            {!inThread && onReply && <button onClick={onReply} title="Reply in thread">↩ Reply</button>}
            <button onClick={() => navigator.clipboard.writeText(m.content)} title="Copy">⧉</button>
          </div>
          {picker && <div className="emoji-picker">{EMOJIS.map((e) => <button key={e} onClick={() => react(e)}>{e}</button>)}</div>}
          {!inThread && m.replyCount > 0 && onReply && (
            <button className="reply-count" onClick={onReply}>💬 {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadPanel() {
  const st = useStore();
  const t = st.thread!;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: 1e9 }); }, [t.messages.length]);
  return (
    <aside className="thread">
      <header className="thread-header">
        <strong>Thread</strong>
        <button className="ghost" onClick={st.closeThread}>✕</button>
      </header>
      <div className="messages" ref={ref}>
        {t.messages.map((m, i) => (
          <div key={m.id}>
            <MessageItem m={m} inThread />
            {i === 0 && <div className="thread-sep">{t.messages.length - 1} replies</div>}
          </div>
        ))}
      </div>
      <Composer chatId={t.chatId} parentId={t.rootId} placeholder="Reply in thread…" />
    </aside>
  );
}

function Composer({ chatId, parentId, placeholder }: { chatId: string; parentId: string | null; placeholder: string }) {
  const { roles, skills, toast } = useStore();
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(() => {
    const at = /^@([\w-]*)$/.exec(text);
    if (at) return roles.filter((r) => r.name.startsWith(at[1]!.toLowerCase())).map((r) => ({ insert: `@${r.name} `, label: `${r.icon} @${r.name}`, hint: r.title }));
    const sl = /^\/([\w-]*)$/.exec(text);
    if (sl) {
      const cmds = [
        { c: "superpowers", d: "toggle the superpowers workflow for this chat" }, { c: "stop", d: "stop agents in this chat" }, { c: "help", d: "list commands and specialists" },
        ...skills.filter((s) => s.command !== "superpowers-index").map((s) => ({ c: s.command, d: s.description })),
      ];
      return cmds.filter((x) => x.c.startsWith(sl[1]!.toLowerCase())).map((x) => ({ insert: `/${x.c} `, label: `/${x.c}`, hint: x.d }));
    }
    return [];
  }, [text, roles, skills]);

  const send = async () => {
    const content = text.trim();
    if (!content) return;
    setText("");
    try {
      await api().sendMessage({ chatId, content, parentId });
    } catch (e: any) {
      toast("error", String(e?.message ?? e));
      setText(content);
    }
  };

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((s, i) => (
            <button key={s.insert} className={i === sel ? "sel" : ""} onMouseDown={(e) => { e.preventDefault(); setText(s.insert); ta.current?.focus(); }}>
              <span>{s.label}</span><span className="muted small">{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      <textarea ref={ta} value={text} placeholder={placeholder} rows={Math.min(8, Math.max(2, text.split("\n").length))}
        onChange={(e) => { setText(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) { e.preventDefault(); setText(suggestions[sel]!.insert); return; }
          if (suggestions.length && e.key === "ArrowDown") { e.preventDefault(); setSel((sel + 1) % suggestions.length); return; }
          if (suggestions.length && e.key === "ArrowUp") { e.preventDefault(); setSel((sel - 1 + suggestions.length) % suggestions.length); return; }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
        }} />
      <button className="primary send" onClick={send} disabled={!text.trim()}>Send ⏎</button>
    </div>
  );
}
