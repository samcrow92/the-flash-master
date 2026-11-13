import { useEffect, useRef, useState } from "react";
import type { HarnessId, Message } from "@shared/types";
import { HARNESS_IDS } from "@shared/types";
import { api, fmtTokens, roleOf, useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { FlowPanel } from "./FlowView";
import { ModelInput } from "../components/ModelInput";
import { UsageMeter } from "../components/UsageMeter";
import { Composer } from "../components/Composer";

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
              <ModelInput className="model-input" harness={chat.harness ?? roleOf(chat.agentRole)?.harness ?? st.settings?.general.defaultHarness ?? null}
                value={chat.model ?? ""} disabled={!!chat.mode} onChange={(v) => update({ model: v || null })} />
            </label>
            {chat.mode && <span className={`pill mode-pill mode-${chat.mode}`} title="Drive mode overrides the harness/model below">{chat.mode.toUpperCase()}</span>}
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
        <Composer chat={chat} parentId={null} busy={busy} placeholder={`Message ${roleOf(chat.agentRole)?.title ?? "agent"} — @ to route, / for commands, paste or drop files`} />
        <UsageMeter />
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
      <div className={`avatar ${m.status === "streaming" ? "avatar-working" : ""}`}><span>{icon}</span></div>
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
          {m.steer && <span className="steer-badge" title="Sent while the agent was working, to steer it">↪ steering</span>}
          {m.author === "user" ? <div className="plain">{m.content}</div> : <Markdown text={m.content || (m.status === "streaming" ? "" : "")} />}
          {m.attachments.length > 0 && (
            <div className="msg-atts">
              {m.attachments.map((a) => (
                <button key={a.id} className={`msg-att ${a.thumb ? "img" : ""}`} title={`${a.name} — click to open`} onClick={() => void api().openAttachment(a.path)}>
                  {a.thumb ? <img src={a.thumb} alt={a.name} /> : <><span>📄</span><span className="att-name">{a.name}</span><span className="muted small">{(a.size / 1024).toFixed(0)} KB</span></>}
                </button>
              ))}
            </div>
          )}
          {m.status === "streaming" && (
            <div className="streaming"><span className="working-dots"><i /><i /><i /></span> <span className="muted small shimmer">{agent?.lastActivity ?? "Working…"}</span></div>
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
      <Composer chat={st.chatById[t.chatId]!} parentId={t.rootId} compact busy={Object.values(st.agents).some((a) => a.chatId === t.chatId && a.status === "running")} placeholder="Reply in thread…" />
    </aside>
  );
}
