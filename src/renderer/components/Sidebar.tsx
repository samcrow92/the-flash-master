import { ResizeHandle } from "./ResizeHandle";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Chat, Project } from "@shared/types";
import { api, useStore } from "../store";
import { UserAvatar } from "./UserAvatar";
import { openMenu, type MenuItem } from "./ContextMenu";
import { Archive, ArchiveRestore, Brain, ChevronRight, Copy, Pin, PinOff, RotateCcw,
  BookOpen, Bot, ClipboardList, Folder, FolderOpen, FolderPlus, LayoutDashboard, ChartGantt, FlaskConical, Waypoints, MessageSquarePlus,
  Download, GitBranch, MoreHorizontal, Pencil, Plus, Puzzle, Search, Settings, SquareKanban, Trash2, Zap,
} from "./icons";
import { SHORTCUTS, shortcutLabel } from "../commands";
import { chatKey, NO_PROJECT } from "../agentChat";
import { newChatIn } from "../chatNav";
import { switcherChats } from "../layout";

const OPEN_PREF = "sidebarOpenProjects";
/** Which project rows are expanded (key: chatKey(projectId)), kept across launches. */
function readOpen(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(OPEN_PREF) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, boolean> : {};
  } catch { return {}; }
}

/**
 * Navigation and projects. A project row expands to list its chats (pinned first, then newest; archived behind a
 * toggle). Replies are not listed here: they open in the chat's side sheet.
 */
export function Sidebar() {
  const st = useStore();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpenState] = useState<Record<string, boolean>>(readOpen);
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  const setOpen = (key: string, value: boolean) => setOpenState((o) => {
    if (!!o[key] === value) return o;
    const next = { ...o, [key]: value };
    try { localStorage.setItem(OPEN_PREF, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });
  const running = Object.values(st.agents).filter((a) => a.status === "running" || a.status === "paused").length;
  const toReview = Object.values(st.agents).filter((a) => a.branch && a.worktree && a.status !== "running").length;
  const view = st.view;
  const isChat = (id: string) => view.kind === "chat" && view.chatId === id;
  const inChat = view.kind === "chat" && !isChat(st.masterChatId ?? "");
  // A project shows a pulse while an agent works in any of its chats.
  const isBusy = (chatId: string) => Object.values(st.agents).some((a) => a.chatId === chatId && a.status === "running");
  // Opening a chat from the switcher, search or a shortcut reveals it here too.
  const currentKey = inChat ? chatKey(st.currentProjectId) : null;
  useEffect(() => { if (currentKey) setOpen(currentKey, true); }, [currentKey]);
  const busyKeys = new Set(Object.values(st.agents).filter((a) => a.status === "running" && a.chatId).map((a) => chatKey(st.chatById[a.chatId!]?.projectId ?? null)));

  const addProject = async () => {
    const path = await api().pickFolder();
    if (!path) return;
    const p = await api().createProject(path);
    await st.refreshProjects();
    await st.refreshChats(p.id);
    setOpen(p.id, true);
    await newChatIn(p.id);
  };
  const fail = (e: any) => st.toast("error", String(e?.message ?? e));
  const newChat = (projectId: string | null) => { setOpen(chatKey(projectId), true); void newChatIn(projectId).catch(fail); };

  const patchChat = async (c: Chat, patch: Partial<Pick<Chat, "title" | "archived" | "pinned">>) => { st.upsertChat(await api().updateChat(c.id, patch)); };
  const leaveChat = async (c: Chat) => { if (isChat(c.id) && st.masterChatId) await st.openChat(st.masterChatId); };
  const chatMenu = (c: Chat): MenuItem[] => [
    { label: "Rename", icon: <Pencil size={15} />, hint: "F2", onClick: () => setRenaming(c.id) },
    { label: c.pinned ? "Unpin" : "Pin to top", icon: c.pinned ? <PinOff size={15} /> : <Pin size={15} />, disabled: c.archived, onClick: () => void patchChat(c, { pinned: !c.pinned }) },
    { label: "Reset context", icon: <RotateCcw size={15} />, disabled: isBusy(c.id),
      onClick: async () => { try { await api().resetContext(c.id); st.toast("info", `Context reset for “${c.title}”`); } catch (e: any) { st.toast("warn", String(e?.message ?? e)); } } },
    { label: "Copy as Markdown", icon: <Copy size={15} />, onClick: async () => { await navigator.clipboard.writeText(await api().exportChat(c.id)); st.toast("info", "Chat copied as Markdown"); } },
    { separator: true, label: "" },
    { label: c.archived ? "Restore from archive" : "Archive", icon: c.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />,
      onClick: async () => { await patchChat(c, { archived: !c.archived, pinned: c.archived ? c.pinned : false }); if (!c.archived) await leaveChat(c); } },
    { label: "Delete", icon: <Trash2 size={15} />, danger: true,
      onClick: async () => { if (!confirm(`Delete “${c.title}” and all its messages? This cannot be undone.`)) return; await api().deleteChat(c.id); st.removeChat(c); await leaveChat(c); } },
  ];

  // Plain render function, not a component defined in render: a component made here would remount on every sidebar
  // re-render (agent status, streaming…) and reset the rename field.
  const chatRow = (c: Chat) => renaming === c.id ? (
    <RenameInput key={c.id} initial={c.title} onCancel={() => setRenaming(null)}
      onDone={async (t) => { setRenaming(null); if (t && t !== c.title) await patchChat(c, { title: t }); }} />
  ) : (
    <div key={c.id} className={`chat-link ${isChat(c.id) ? "active" : ""} ${c.archived ? "archived" : ""}`} role="button" tabIndex={0}
      onClick={() => void st.openChat(c.id)} onDoubleClick={() => setRenaming(c.id)} onContextMenu={(e) => openMenu(e, chatMenu(c))}
      onKeyDown={(e) => { if (e.key === "F2") setRenaming(c.id); if (e.key === "Enter") void st.openChat(c.id); }}>
      {c.pinned && <Pin size={12} className="chat-pin" />}
      {c.archived && <Archive size={12} className="chat-pin" />}
      <span className="chat-title">{c.title}</span>
      {isBusy(c.id) && <span className="pulse" />}
      <button className="row-more" title="More" aria-label={`More for ${c.title}`} onClick={(e) => { e.stopPropagation(); openMenu(e, chatMenu(c), true); }}><MoreHorizontal size={15} /></button>
    </div>
  );
  /** A project's chats under its row, newest first with pinned on top, and the archived ones behind a toggle. */
  const chatList = (key: string) => {
    const { active, archived } = switcherChats(st.chats[key] ?? []);
    return (
      <div className="chat-list">
        {active.map(chatRow)}
        {!active.length && <button className="archived-toggle" onClick={() => newChat(key === NO_PROJECT ? null : key)}><Plus size={12} /> New chat</button>}
        {archived.length > 0 && (
          <button className="archived-toggle" onClick={() => setShowArchived((o) => ({ ...o, [key]: !o[key] }))}>
            <Archive size={12} /> {showArchived[key] ? "Hide" : "Show"} archived ({archived.length})
          </button>
        )}
        {showArchived[key] && archived.map(chatRow)}
      </div>
    );
  };

  const projectMenu = (p: Project): MenuItem[] => [
    { label: "New chat", icon: <MessageSquarePlus size={15} />, onClick: () => newChat(p.id) },
    { label: "Rename project", icon: <Pencil size={15} />, hint: "F2", onClick: () => setRenaming(`project:${p.id}`) },
    { label: "Open folder", icon: <FolderOpen size={15} />, onClick: () => api().openProjectFolder(p.id) },
    { separator: true, label: "" },
    { label: "Remove project", icon: <Trash2 size={15} />, danger: true, hint: "files stay",
      onClick: async () => { if (confirm(`Remove “${p.name}” from TheFlashMaster? Its chats are deleted; the folder on disk is not touched.`)) { await api().removeProject(p.id); await st.refreshProjects(); } } },
  ];

  const openTasks = Object.values(st.tasks).filter((t) => t.status !== "done").length;
  const mac = st.window?.platform === "darwin";

  return (
    <aside className="sidebar">
      <button className="new-chat-btn" title="New chat with TheFlashMaster in the current project"
        onClick={() => void newChatIn(st.currentProjectId).catch(fail)}>
        <Plus size={16} /> <span>New chat</span><kbd className="nav-kbd">{shortcutLabel(SHORTCUTS.newChat.keys, mac)}</kbd>
      </button>

      <nav className="nav">
        <NavBtn active={isChat(st.masterChatId ?? "")} working={Object.values(st.agents).some((a) => a.role === "flashmaster" && a.status === "running")}
          onClick={() => st.masterChatId && st.openChat(st.masterChatId)} icon={<Zap size={17} />} label="Master chat" />
        <NavBtn active={st.searchOpen} onClick={() => useStore.setState({ searchOpen: true })} icon={<Search size={17} />} label="Search chats"
          extra={<kbd className="nav-kbd">{shortcutLabel(SHORTCUTS.search.keys, mac)}</kbd>} />
        <NavBtn active={view.kind === "agents"} onClick={() => st.setView({ kind: "agents" })} icon={<Bot size={17} />} label="Agents"
          extra={running > 0 && <span className="badge">{running}</span>} />
        <NavBtn active={view.kind === "review"} onClick={() => st.setView({ kind: "review" })} icon={<GitBranch size={17} />} label="Review"
          extra={toReview > 0 && <span className="badge" title="Agent branches waiting for review">{toReview}</span>} />
        <NavBtn active={view.kind === "dashboard"} onClick={() => st.setView({ kind: "dashboard" })} icon={<LayoutDashboard size={17} />} label="Dashboard" />
        <NavBtn active={view.kind === "timeline"} onClick={() => st.setView({ kind: "timeline" })} icon={<ChartGantt size={17} />} label="Timeline" />
        <NavBtn active={view.kind === "evals"} onClick={() => st.setView({ kind: "evals" })} icon={<FlaskConical size={17} />} label="Evals" />
        <NavBtn active={view.kind === "traceability"} onClick={() => st.setView({ kind: "traceability" })} icon={<Waypoints size={17} />} label="Traceability" />
        <NavBtn active={view.kind === "tasks"} onClick={() => st.setView({ kind: "tasks" })} icon={<SquareKanban size={17} />} label="Tasks"
          extra={openTasks > 0 && <span className="count">{openTasks}</span>} />
        <NavBtn active={view.kind === "memory"} onClick={() => st.setView({ kind: "memory" })} icon={<Brain size={17} />} label="Memory" />
        <NavBtn active={view.kind === "jazz"} onClick={() => st.setView({ kind: "jazz" })} icon={<ClipboardList size={17} />} label="IBM Jazz" />
        <NavBtn active={view.kind === "marketplace"} onClick={() => st.setView({ kind: "marketplace" })} icon={<Puzzle size={17} />} label="Marketplace" />
        <NavBtn active={view.kind === "docs"} onClick={() => st.setView({ kind: "docs" })} icon={<BookOpen size={17} />} label="Documentation" />
      </nav>

      <div className="section-title">
        Projects <button className="icon-btn" title="Add project folder" onClick={addProject}><FolderPlus size={15} /></button>
      </div>
      <div className="projects">
        {st.projects.length === 0 && <div className="empty-hint">Add a local folder to start.</div>}
        {st.projects.map((p) => (
          <div key={p.id} className="project">
            <div className={`project-row ${currentKey === p.id ? "current" : ""}`} onContextMenu={(e) => openMenu(e, projectMenu(p))}>
              {renaming === `project:${p.id}` ? (
                // window.prompt() isn't supported in Electron: rename inline.
                <RenameInput key={`project:${p.id}`} initial={p.name} onCancel={() => setRenaming(null)}
                  onDone={async (n) => { setRenaming(null); if (n && n !== p.name) { await api().renameProject(p.id, n); await st.refreshProjects(); } }} />
              ) : (
                <button className="project-name" title={p.path} aria-expanded={!!open[p.id]} onClick={() => setOpen(p.id, !open[p.id])}
                  onDoubleClick={() => setRenaming(`project:${p.id}`)} onKeyDown={(e) => { if (e.key === "F2") setRenaming(`project:${p.id}`); }}>
                  <ChevronRight size={13} className={`chev ${open[p.id] ? "open" : ""}`} />
                  <Folder size={15} className="project-icon" /> <span className="project-label">{p.name}</span>
                  {!open[p.id] && busyKeys.has(p.id) && <span className="pulse" title="An agent is working here" />}
                </button>
              )}
              <button className="icon-btn" title="More" onClick={(e) => openMenu(e, projectMenu(p), true)}><MoreHorizontal size={15} /></button>
              <button className="icon-btn" title="New chat" onClick={() => newChat(p.id)}><Plus size={15} /></button>
            </div>
            {open[p.id] && chatList(p.id)}
          </div>
        ))}
        <NoProjectSection count={(st.chats[NO_PROJECT] ?? []).length} open={!!open[NO_PROJECT]} current={currentKey === NO_PROJECT}
          busy={busyKeys.has(NO_PROJECT)} onToggle={() => setOpen(NO_PROJECT, !open[NO_PROJECT])}>{chatList(NO_PROJECT)}</NoProjectSection>
      </div>

      {st.update && ["available", "downloading", "ready"].includes(st.update.status) && (
        <button className={`update-pill ${st.update.status}`} onClick={() => st.update?.status === "ready" ? api().updateInstall() : st.setView({ kind: "settings", tab: "about" })}
          title={st.update.status === "ready" ? "Restart TheFlashMaster and install the update" : "Open update details"}>
          <Download size={14} />
          <span>{st.update.status === "ready" ? `Restart to update to ${st.update.latest}` : st.update.status === "downloading" ? `Downloading ${st.update.latest}… ${st.update.progress ?? 0}%` : `Update ${st.update.latest} available`}</span>
        </button>
      )}
      <div className="sidebar-footer row">
        <button className="profile-btn" title={`${st.settings?.profile.name || "Your profile"} — change name and picture`}
          onClick={() => st.setView({ kind: "settings", tab: "general" })}><UserAvatar size={26} /></button>
        <button className={`nav-btn ${view.kind === "settings" ? "active" : ""}`} onClick={() => st.setView({ kind: "settings" })}><span className="nav-icon"><Settings size={17} /></span> Settings</button>
      </div>
      <ResizeHandle panel="sidebar" edge="right" label="Resize sidebar" />
    </aside>
  );
}

/** Agents and chats whose project couldn't be determined (started from the master chat with no project selected): a row like a project. */
function NoProjectSection({ count, open, current, busy, onToggle, children }: {
  count: number; open: boolean; current: boolean; busy: boolean; onToggle: () => void; children: ReactNode;
}) {
  if (!count) return null;
  return (
    <div className="project no-project">
      <div className={`project-row ${current ? "current" : ""}`}>
        <button className="project-name" title="Chats and agents that don't belong to a project" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
          <Folder size={15} className="project-icon" /> <span className="project-label">No project</span>
          {!open && busy && <span className="pulse" title="An agent is working here" />}
        </button>
      </div>
      {open && children}
    </div>
  );
}

/** Sidebar navigation button (top-level component: stable identity across re-renders). */
function NavBtn({ active, onClick, icon, label, extra, working }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; extra?: ReactNode; working?: boolean }) {
  return (
    <button className={`nav-btn ${active ? "active" : ""} ${working ? "nav-working" : ""}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>{extra}
    </button>
  );
}

/** Inline rename field with its own state, so sidebar updates while typing cannot reset it. */
function RenameInput({ initial, onDone, onCancel }: { initial: string; onDone: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (save: boolean) => { if (done.current) return; done.current = true; if (save) onDone(value.trim()); else onCancel(); };
  return (
    <input className="chat-rename" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); }} />
  );
}
