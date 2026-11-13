import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ToolRuns } from "../components/ToolRuns";
import type { HarnessId, Message } from "@shared/types";
import { HARNESS_IDS } from "@shared/types";
import { ago, api, fmtTokens, roleOf, useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { FlowPanel } from "./FlowView";
import { ModelInput } from "../components/ModelInput";
import { UsageMeter } from "../components/UsageMeter";
import { Composer } from "../components/Composer";
import { openMenu } from "../components/ContextMenu";
import { UserAvatar } from "../components/UserAvatar";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { AppWindow, Archive, ChevronDown, ChevronUp, PanelRight, X, Compass, Copy, CornerUpLeft, FileText, MessageCircle, MoreHorizontal, Pause, Pencil, Pin, PinOff, Play, RoleIcon, RotateCcw, Package, Smile, Clock, Check, CheckCheck, Hourglass, Square, Trash2, Info, Zap } from "../components/icons";

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

  // Stick to the latest message: on open / chat switch, while content grows (streaming, images, diagrams)
  // and for new messages — until the user scrolls up to read; scrolling back down re-attaches.
  const innerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const toBottom = () => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; };
  useLayoutEffect(() => { pinned.current = true; toBottom(); }, [chatId]);
  useLayoutEffect(() => { if (pinned.current) toBottom(); }, [messages]);
  useEffect(() => {
    const el = listRef.current, inner = innerRef.current;
    if (!el || !inner) return;
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    const ro = new ResizeObserver(() => { if (pinned.current) toBottom(); });
    ro.observe(inner);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, [chatId, !!chat]);

  if (!chat) return <div className="empty">Chat not found.</div>;

  // Briefly highlight the Artifacts button when agents produce something new
  const artRev = useStore((s) => s.artifactsRev[chatId] ?? 0);
  const [artPulse, setArtPulse] = useState(false);
  useEffect(() => { if (!artRev) return; setArtPulse(true); const t = setTimeout(() => setArtPulse(false), 1800); return () => clearTimeout(t); }, [artRev]);
  const update = async (patch: Partial<typeof chat>) => st.upsertChat(await api().updateChat(chatId, patch));
  const isMaster = chat.kind === "master";

  return (
    <div className={`chat-layout ${st.sideThread?.chatId === chatId || st.flowPanel?.chatId === chatId || st.artifactsPanel === chatId ? "with-thread" : ""}`}>
      <section className="chat">
        <header className="chat-header">
          <div className="chat-title-block">
            {editingTitle ? (
              <input autoFocus className="title-input" defaultValue={chat.title}
                onBlur={(e) => { setEditingTitle(false); if (e.target.value.trim()) void update({ title: e.target.value.trim() }); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            ) : (
              <h2 className="chat-h2" onDoubleClick={() => !isMaster && setEditingTitle(true)} title={isMaster ? "" : "Double-click to rename"}>
                {isMaster ? <><Zap size={18} className="h2-bolt" /> TheFlashMaster — master chat</> : chat.title}
                {!isMaster && <button className="title-edit" title="Rename chat" onClick={() => setEditingTitle(true)}><Pencil size={14} /></button>}
              </h2>
            )}
            <div className="muted small">{project ? project.path : isMaster ? "Coordinator across all projects" : "No project"}</div>
          </div>
          <div className="chat-controls">
            <label className="ctl" title="Default agent for this chat (override per message with @role)">
              <span>Agent</span>
              <select value={chat.agentRole} onChange={(e) => update({ agentRole: e.target.value })}>
                {st.roles.map((r) => <option key={r.name} value={r.name}>{r.title}</option>)}
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
              onClick={() => (st.flowPanel?.chatId === chatId ? useStore.setState({ flowPanel: null }) : st.openFlow(chatId, null))}><Compass size={15} /> Progress</button>
            <button className={`${st.artifactsPanel === chatId ? "toggle on" : ""} ${artPulse ? "art-pulse" : ""}`} title="Files changed, saved artifacts and code from this chat — download and diff"
              onClick={() => useStore.setState({ artifactsPanel: st.artifactsPanel === chatId ? null : chatId, flowPanel: null, sideThread: null })}><Package size={15} /> Artifacts</button>
            {busy && <button className="danger" onClick={() => chatAgents.forEach((a) => api().stopAgent(a.id))}><Square size={13} fill="currentColor" /> Stop</button>}
            <button className="ghost icon-only" title="More actions" onClick={(e) => openMenu(e, [
              ...(!isMaster ? [{ label: "Rename", icon: <Pencil size={15} />, onClick: () => setEditingTitle(true) },
                { label: chat.pinned ? "Unpin" : "Pin to top", icon: chat.pinned ? <PinOff size={15} /> : <Pin size={15} />, onClick: () => update({ pinned: !chat.pinned }) }] : []),
              { label: "Reset context", icon: <RotateCcw size={15} />, disabled: busy, onClick: () => api().resetContext(chatId).catch((er) => st.toast("warn", String(er?.message ?? er))) },
              { label: "Copy as Markdown", icon: <Copy size={15} />, onClick: async () => { await navigator.clipboard.writeText(await api().exportChat(chatId)); st.toast("info", "Chat copied as Markdown"); } },
              ...(!isMaster ? [{ separator: true, label: "" },
                { label: "Archive", icon: <Archive size={15} />, onClick: async () => { st.upsertChat(await api().updateChat(chatId, { archived: true, pinned: false })); if (st.masterChatId) void st.openChat(st.masterChatId); } },
                { label: "Delete", icon: <Trash2 size={15} />, danger: true, onClick: async () => {
                  if (!confirm(`Delete chat "${chat.title}"?`)) return;
                  await api().deleteChat(chatId);
                  st.removeChat(chat);
                  if (st.masterChatId) void st.openChat(st.masterChatId);
                } }] : []),
            ], true)}><MoreHorizontal size={17} /></button>
          </div>
        </header>

        {chatAgents.length > 0 && (
          <div className="agent-strip">
            {chatAgents.map((a) => (
              <span key={a.id} className={`agent-chip st-${a.status}`} title={`${a.lastActivity ?? ""}\nClick to see the progress flow`}>
                <button className="chip-main" onClick={() => st.openFlow(chatId, a.id)}>
                  <RoleIcon role={a.role} emoji={roleOf(a.role)?.icon} size={16} /> {roleOf(a.role)?.title ?? a.role} · {a.harness} · {a.status}
                  {a.plan.length > 0 && ` · ${a.plan.filter((p) => p.status === "completed").length}/${a.plan.length}`}
                </button>
                {a.status === "running" && <button onClick={() => api().pauseAgent(a.id)} title="Pause"><Pause size={12} /></button>}
                {a.status === "paused" && <button onClick={() => api().resumeAgent(a.id)} title="Resume"><Play size={12} /></button>}
                <button onClick={() => api().stopAgent(a.id)} title="Stop"><Square size={11} fill="currentColor" /></button>
              </span>
            ))}
          </div>
        )}

        <div className="messages" ref={listRef}>
          <div className="messages-inner" ref={innerRef}>
            {messages.length === 0 && <EmptyChat isMaster={isMaster} />}
            {messages.map((m) => <MessageItem key={m.id} m={m} />)}
          </div>
        </div>
        <Composer chat={chat} parentId={null} busy={busy} placeholder={`Message ${roleOf(chat.agentRole)?.title ?? "agent"} — @ to route, / for commands, paste or drop files`} />
        <UsageMeter />
      </section>
      {st.sideThread?.chatId === chatId && <ThreadPanel key={st.sideThread.rootId} chatId={chatId} rootId={st.sideThread.rootId} onClose={st.closeSideThread} />}
      {st.artifactsPanel === chatId && <ArtifactsPanel chatId={chatId} onClose={() => useStore.setState({ artifactsPanel: null })} />}
      {st.flowPanel?.chatId === chatId && <FlowPanel chatId={chatId} agentId={st.flowPanel.agentId} onClose={() => useStore.setState({ flowPanel: null })} />}
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

const DELIVERY = {
  sent: { icon: Clock, label: "sending", tip: "Waiting for the agent to take it" },
  queued: { icon: Hourglass, label: "queued", tip: "Will be sent when the agent finishes its current turn" },
  delivered: { icon: Check, label: "delivered", tip: "The agent received it" },
  seen: { icon: CheckCheck, label: "seen", tip: "The model continued with this message in its context" },
} as const;

/** Steering / queued message status: sending → delivered → seen (or queued → delivered → seen). */
function DeliveryBadge({ steer, state }: { steer: boolean; state?: keyof typeof DELIVERY }) {
  const d = DELIVERY[state ?? (steer ? "sent" : "queued")];
  const I = d.icon;
  return (
    <span className={`steer-badge dl-${state ?? "sent"}`} title={`${steer ? "Steering message" : "Queued message"} — ${d.tip}`}>
      {steer && <><CornerUpLeft size={11} /> steering <span className="dl-sep">·</span></>}
      <span key={state} className="dl-state"><I size={12} strokeWidth={2.4} /> {d.label}</span>
    </span>
  );
}

export function MessageItem({ m, inThread }: { m: Message; inThread?: boolean }) {
  const role = roleOf(m.role);
  const threadOpen = useStore((s) => !inThread && !!s.openThreads[m.id]);
  const [focusReq, setFocusReq] = useState(0);
  const reply = () => { if (!threadOpen) void useStore.getState().openThread(m.chatId, m.id); setFocusReq((n) => n + 1); };
  const toggleThread = () => useStore.getState().toggleThread(m.chatId, m.id);
  const agent = useStore((s) => (m.agentId ? s.agents[m.agentId] : undefined));
  const showTokens = useStore((s) => s.settings?.tokens.showTokenCounts);
  const [picker, setPicker] = useState(false);
  const myName = useStore((s) => s.settings?.profile?.name);
  const who = m.author === "user" ? myName || "You" : m.author === "system" ? "System" : role?.title ?? m.role ?? "Agent";
  const react = (e: string) => { setPicker(false); void api().toggleReaction(m.id, e); };

  if (m.marker === "context-reset") {
    return <div className="ctx-divider" title={new Date(m.createdAt).toLocaleString()}><span><RotateCcw size={13} /> Context reset — agents start fresh from here</span></div>;
  }
  const sz = inThread ? 24 : 32;
  const avatar = m.author === "user" ? <button className="avatar-btn" title="Change your picture" onClick={() => useStore.getState().setView({ kind: "settings", tab: "general" })}><UserAvatar size={sz} /></button>
    : m.author === "system" ? <span className="role-badge sys"><Info size={inThread ? 12 : 15} /></span>
    : <RoleIcon role={m.role} emoji={role?.icon} size={sz} />;

  return (
    <div className={`msg msg-${m.author} ${m.status === "error" ? "msg-error" : ""}`}>
      <div className={`avatar ${m.status === "streaming" ? "avatar-working" : ""}`}>{avatar}</div>
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
          {(m.steer || m.delivery) && <DeliveryBadge steer={m.steer} state={m.delivery} />}
          {!!m.tools?.length && <ToolRuns tools={m.tools} />}
          {m.author === "user" ? <div className="plain">{m.content}</div> : <Markdown text={m.content || (m.status === "streaming" ? "" : "")} />}
          {m.attachments.length > 0 && (
            <div className="msg-atts">
              {m.attachments.map((a) => (
                <button key={a.id} className={`msg-att ${a.thumb ? "img" : ""}`} title={`${a.name} — click to open`} onClick={() => void api().openAttachment(a.path)}>
                  {a.thumb ? <img src={a.thumb} alt={a.name} /> : <><FileText size={16} /><span className="att-name">{a.name}</span><span className="muted small">{(a.size / 1024).toFixed(0)} KB</span></>}
                </button>
              ))}
            </div>
          )}
          {m.status === "streaming" && (
            <div className="streaming"><span className="working-dots"><i /><i /><i /></span> <span className="muted small shimmer">{agent?.lastActivity ?? "Working…"}</span></div>
          )}
        </div>
        <div className="msg-footer">
          {!inThread && m.replyCount > 0 && <ThreadPill root={m} open={threadOpen} onClick={toggleThread} />}
          {m.reactions.map((r) => <button key={r} className="reaction" onClick={() => react(r)} title="Toggle reaction">{r}</button>)}
          <div className="msg-actions">
            <button onClick={() => setPicker((p) => !p)} title="React"><Smile size={14} /></button>
            {!inThread && <button onClick={reply} title="Reply in thread"><CornerUpLeft size={13} /> Reply</button>}
            <button onClick={() => navigator.clipboard.writeText(m.content)} title="Copy"><Copy size={13} /></button>
          </div>
          {picker && <div className="emoji-picker">{EMOJIS.map((e) => <button key={e} onClick={() => react(e)}>{e}</button>)}</div>}
        </div>
        {!inThread && <InlineThread root={m} open={threadOpen} focusReq={focusReq} />}
      </div>
    </div>
  );
}

const plural = (n: number) => `${n} ${n === 1 ? "reply" : "replies"}`;

/** The "N replies" pill under a message: who replied, how many, and a chevron that flips when the thread is open. */
function ThreadPill({ root, open, onClick }: { root: Message; open: boolean; onClick: () => void }) {
  const replies = useStore((s) => s.threads[root.id])?.filter((r) => r.id !== root.id);
  const faces: Message[] = [];
  for (const r of replies ?? []) if (!faces.some((f) => f.author === r.author && f.role === r.role)) faces.push(r);
  const last = replies?.at(-1);
  return (
    <button className={`thread-pill ${open ? "open" : ""}`} onClick={onClick} aria-expanded={open} title={open ? "Collapse thread" : "Expand thread"}>
      <span className="tp-faces">
        {faces.length ? faces.slice(0, 3).map((f) => (
          <span key={f.id} className="tp-face">{f.author === "user" ? <UserAvatar size={18} /> : f.author === "system" ? <span className="role-badge sys"><Info size={10} /></span> : <RoleIcon role={f.role} emoji={roleOf(f.role)?.icon} size={18} />}</span>
        )) : <MessageCircle size={13} />}
      </span>
      <span className="tp-count">{plural(root.replyCount)}</span>
      {last && <span className="tp-last">· last {ago(last.createdAt)} ago</span>}
      <ChevronDown size={13} className="tp-chev" />
    </button>
  );
}

/**
 * Replies shown inline under their root message. Expanding animates the height (grid 0fr → 1fr), fades the card in and
 * staggers the replies; collapsing plays it backwards and unmounts once the transition is over.
 */
function InlineThread({ root, open, focusReq }: { root: Message; open: boolean; focusReq: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) { setMounted(true); return; }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 380);
    return () => clearTimeout(t);
  }, [open]);
  // Mounted collapsed → force a style flush → flip to open, so the browser animates from 0 height.
  useLayoutEffect(() => {
    if (mounted && open && !shown && ref.current) { void ref.current.offsetHeight; setShown(true); }
  }, [mounted, open, shown]);
  // "Reply" focuses the thread's composer once the card has opened, bringing it into view.
  useEffect(() => {
    if (!focusReq) return;
    const t = setTimeout(() => {
      const ta = ref.current?.querySelector("textarea");
      ta?.focus({ preventScroll: true });
      ta?.closest(".composer-wrap")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 260);
    return () => clearTimeout(t);
  }, [focusReq]);

  if (!mounted) return null;
  return (
    <div ref={ref} className={`inline-thread ${shown ? "open" : ""}`} inert={!open}>
      <div className="it-clip"><ThreadCard root={root} /></div>
    </div>
  );
}

function ThreadCard({ root }: { root: Message }) {
  const replies = useStore((s) => s.threads[root.id])?.filter((r) => r.id !== root.id);
  const chat = useStore((s) => s.chatById[root.chatId]);
  const busy = useStore((s) => Object.values(s.agents).some((a) => a.chatId === root.chatId && a.status === "running"));
  if (!chat) return null;
  const n = replies?.length ?? root.replyCount;
  return (
        <div className="it-card">
          <header className="it-head">
            <span className="it-title"><MessageCircle size={14} /> Thread</span>
            <span className="it-sub">{n ? plural(n) : "No replies yet"}</span>
            <span className="it-tools">
              <button className="it-collapse" title="Open in side panel" onClick={() => useStore.getState().openSideThread(root.chatId, root.id)}><PanelRight size={14} /></button>
              <button className="it-collapse" title="Open in new window" onClick={() => void api().openThreadWindow(root.chatId, root.id)}><AppWindow size={14} /></button>
              <button className="it-collapse" title="Collapse thread" onClick={() => useStore.getState().closeThread(root.id)}><ChevronUp size={15} /></button>
            </span>
          </header>
          <div className="it-list">
            {replies === undefined
              ? <div className="it-loading"><span className="working-dots"><i /><i /><i /></span></div>
              : replies.length === 0
                ? <div className="it-empty">Start the thread — replies stay attached to this message.</div>
                : replies.map((r, i) => (
                  <div key={r.id} className="it-item" style={{ "--i": Math.min(i, 10) } as CSSProperties}><MessageItem m={r} inThread /></div>
                ))}
          </div>
          <Composer chat={chat} parentId={root.id} compact busy={busy} placeholder="Reply in thread…" />
        </div>
  );
}

/**
 * A thread as its own column: the classic side panel next to the chat, and the whole content of a pop-out thread window.
 * `onClose` is absent in the pop-out (the window has its own close button).
 */
export function ThreadPanel({ chatId, rootId, onClose, standalone }: { chatId: string; rootId: string; onClose?: () => void; standalone?: boolean }) {
  const list = useStore((s) => s.threads[rootId]);
  const chat = useStore((s) => s.chatById[chatId]);
  const busy = useStore((s) => Object.values(s.agents).some((a) => a.chatId === chatId && a.status === "running"));
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => { const el = ref.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [list]);
  if (!chat) return null;
  const root = list?.find((m) => m.id === rootId);
  const replies = list?.filter((m) => m.id !== rootId) ?? [];
  return (
    <aside className={`thread thread-side ${standalone ? "thread-standalone" : ""}`}>
      <header className="thread-header">
        <div className="thread-title">
          <strong><MessageCircle size={15} /> Thread</strong>
          {standalone && <span className="muted small">{chat.title}</span>}
        </div>
        <span className="it-tools">
          {!standalone && <button className="it-collapse" title="Open in new window" onClick={() => { void api().openThreadWindow(chatId, rootId); onClose?.(); }}><AppWindow size={15} /></button>}
          {onClose && <button className="it-collapse" title="Close thread" onClick={onClose}><X size={16} /></button>}
        </span>
      </header>
      <div className="messages" ref={ref} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {!list ? <div className="it-loading"><span className="working-dots"><i /><i /><i /></span></div> : <>
          {root && <MessageItem m={root} inThread />}
          <div className="thread-sep">{replies.length ? plural(replies.length) : "No replies yet"}</div>
          {replies.map((m) => <MessageItem key={m.id} m={m} inThread />)}
        </>}
      </div>
      <Composer chat={chat} parentId={rootId} compact busy={busy} placeholder="Reply in thread…" />
    </aside>
  );
}
