import { ResizeHandle } from "../components/ResizeHandle";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Message } from "@shared/types";
import { ago, roleOf, useStore } from "../store";
import { chatThreads, splitArchived, threadsPanelMode, type ThreadSummary } from "../threadList";
import { threadMenu } from "../threadActions";
import { openMenu } from "../components/ContextMenu";
import { MessageItem } from "./ChatView";
import { Composer } from "../components/Composer";
import { UserAvatar } from "../components/UserAvatar";
import { Dots } from "../components/Dots";
import { Archive, ChevronRight, ChevronsDownUp, ChevronsUpDown, Info, LocateFixed, MessagesSquare, MoreHorizontal, PanelRightClose, PanelRightOpen, RoleIcon } from "../components/icons";

const plural = (n: number) => `${n} ${n === 1 ? "reply" : "replies"}`;
/** Thread lists already requested for the panel's summaries (who replied, when), so each loads once. */
const requested = new Set<string>();

/**
 * The Threads panel on the right of a chat: every thread in the chat, each expandable in place (replies + a reply box),
 * with expand/collapse all. The panel folds to a slim rail; it does so on its own while Progress or Artifacts is open.
 */
export function ThreadsPanel({ chatId, otherPanel }: { chatId: string; otherPanel: boolean }) {
  const roots = useStore((s) => s.messages[chatId]);
  const threads = useStore((s) => s.threads);
  const panelThreads = useStore((s) => s.panelThreads);
  const open = useStore((s) => s.threadsPanelOpen);
  const focus = useStore((s) => s.panelFocus);
  const [openedEmpty, setOpenedEmpty] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const all = useMemo(() => chatThreads(roots ?? [], threads, panelThreads), [roots, threads, panelThreads]);
  const { active: list, archived } = useMemo(() => splitArchived(all), [all]);
  const mode = threadsPanelMode({ open, otherPanel, count: list.length + archived.length, openedEmpty });
  const listRef = useRef<HTMLDivElement>(null);

  // Load each thread once while the panel is shown, so rows can show who replied and when.
  useEffect(() => {
    if (mode !== "full") return;
    for (const t of showArchived ? all : list) {
      if (threads[t.rootId] || requested.has(t.rootId)) continue;
      requested.add(t.rootId);
      void useStore.getState().loadThread(chatId, t.rootId).catch(() => requested.delete(t.rootId));
    }
  }, [mode, list, all, showArchived, threads, chatId]);

  // "Show in Threads panel" from a thread: scroll its row into view and flash it.
  useEffect(() => {
    if (!focus || mode !== "full") return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thread-root="${CSS.escape(focus.rootId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("tpl-flash");
    void el.offsetWidth;
    el.classList.add("tpl-flash");
    useStore.setState({ panelFocus: null });
  }, [focus, mode, list]);

  const expand = () => {
    if (otherPanel) useStore.setState({ flowPanel: null, artifactsPanel: null });
    useStore.getState().setThreadsPanel(true);
    if (!list.length) setOpenedEmpty(true);
  };

  if (mode === "rail") {
    const working = list.some((t) => t.working);
    return (
      <aside className="threads-panel tpl-rail">
        <button className="tpl-rail-btn" onClick={expand}
          title={list.length ? `Show the Threads panel (${list.length} in this chat)` : "Show the Threads panel — no threads in this chat yet"}>
          <PanelRightOpen size={16} />
          <span className="tpl-rail-icon"><MessagesSquare size={16} />{working && <i className="tpl-dot" />}</span>
          <span className="tpl-rail-count">{list.length}</span>
        </button>
      </aside>
    );
  }

  const allOpen = list.length > 0 && list.every((t) => panelThreads[t.rootId]);
  return (
    <aside className="threads-panel tpl-full">
      <header className="tpl-head">
        <strong><MessagesSquare size={15} /> Threads</strong>
        <span className="tpl-count">{list.length}</span>
        <span className="it-tools">
          {list.length > 0 && (
            <button className="it-collapse" title={allOpen ? "Collapse all threads" : "Expand all threads"}
              onClick={() => useStore.getState().setPanelThreads(chatId, list.map((t) => t.rootId), !allOpen)}>
              {allOpen ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
            </button>
          )}
          <button className="it-collapse" title="Collapse the Threads panel" onClick={() => { useStore.getState().setThreadsPanel(false); setOpenedEmpty(false); }}>
            <PanelRightClose size={15} />
          </button>
        </span>
      </header>
      <div className="tpl-list" ref={listRef}>
        {list.length === 0
          ? <div className="tpl-empty"><MessagesSquare size={22} /><span>{archived.length ? "No open threads." : "No threads in this chat yet."}</span><span className="muted small">Hover a message and click Reply to start one.</span></div>
          : list.map((t) => <ThreadRow key={t.rootId} chatId={chatId} t={t} expanded={!!panelThreads[t.rootId]} />)}
        {archived.length > 0 && (
          <div className={`tpl-archived ${showArchived ? "open" : ""}`}>
            <button className="tpl-archived-head" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}
              title={showArchived ? "Hide archived threads" : "Show archived threads"}>
              <ChevronRight size={13} className="tpl-chev" /><Archive size={13} /> Archived <span className="tpl-count">{archived.length}</span>
            </button>
            {showArchived && archived.map((t) => <ThreadRow key={t.rootId} chatId={chatId} t={t} expanded={!!panelThreads[t.rootId]} />)}
          </div>
        )}
      </div>
      <ResizeHandle panel="threads" edge="left" label="Resize Threads panel" />
    </aside>
  );
}

function Face({ m, size }: { m: Message; size: number }) {
  return m.author === "user" ? <UserAvatar size={size} />
    : m.author === "system" ? <span className="role-badge sys"><Info size={Math.round(size * 0.55)} /></span>
    : <RoleIcon role={m.role} size={size} framed state={m.status === "streaming" ? "working" : undefined} />;
}

function ThreadRow({ chatId, t, expanded }: { chatId: string; t: ThreadSummary; expanded: boolean }) {
  const replies = useStore((s) => s.threads[t.rootId])?.filter((r) => r.id !== t.rootId);
  const myName = useStore((s) => s.settings?.profile?.name);
  const r = t.root;
  const who = r.author === "user" ? myName || "You" : r.author === "system" ? "System" : roleOf(r.role)?.title ?? r.role ?? "Agent";
  const faces: Message[] = [];
  for (const x of replies ?? []) if (!faces.some((f) => f.author === x.author && f.role === x.role)) faces.push(x);
  const jump = () => useStore.setState({ focusMessage: { id: t.rootId, rootId: null, at: Date.now() } });

  return (
    <section className={`tpl-item ${expanded ? "open" : ""} ${t.working ? "working" : ""}`} data-thread-root={t.rootId}>
      <div className="tpl-row">
        <button className="tpl-toggle" aria-expanded={expanded} title={expanded ? "Collapse thread" : "Expand thread"}
          onClick={() => useStore.getState().togglePanelThread(chatId, t.rootId)}>
          <ChevronRight size={14} className="tpl-chev" />
          <span className="tpl-av"><Face m={r} size={20} /></span>
          <span className="tpl-main">
            <span className="tpl-line1"><span className="tpl-who">{who}</span><span className="tpl-time">{ago(t.lastAt)} ago</span></span>
            <span className="tpl-preview">{t.preview}</span>
            <span className="tpl-meta">
              {faces.length > 0 && <span className="tp-faces">{faces.slice(0, 3).map((f) => <span key={f.id} className="tp-face"><Face m={f} size={16} /></span>)}</span>}
              <span>{t.replyCount ? plural(t.replyCount) : "No replies yet"}</span>
              {t.working && <Dots />}
            </span>
          </span>
        </button>
        <button className="it-collapse tpl-jump" title="Show in chat" onClick={jump}><LocateFixed size={14} /></button>
        <button className="it-collapse tpl-jump" title="Thread actions" aria-label="Thread actions"
          onClick={(e) => openMenu(e, threadMenu(r), true)}><MoreHorizontal size={14} /></button>
      </div>
      {expanded && <ThreadBody chatId={chatId} rootId={t.rootId} replies={replies} />}
    </section>
  );
}

function ThreadBody({ chatId, rootId, replies }: { chatId: string; rootId: string; replies: Message[] | undefined }) {
  const chat = useStore((s) => s.chatById[chatId]);
  const busy = useStore((s) => Object.values(s.agents).some((a) => a.chatId === chatId && a.status === "running"));
  if (!chat) return null;
  return (
    <div className="tpl-body">
      <div className="tpl-replies">
        {replies === undefined
          ? <div className="it-loading"><Dots /></div>
          : replies.length === 0
            ? <div className="it-empty">Start the thread — replies stay attached to this message.</div>
            : replies.map((m, i) => <div key={m.id} className="it-item" style={{ "--i": Math.min(i, 10) } as CSSProperties}><MessageItem m={m} inThread /></div>)}
      </div>
      <Composer chat={chat} parentId={rootId} compact busy={busy} placeholder="Reply in thread…" />
    </div>
  );
}
