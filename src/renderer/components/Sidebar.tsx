import { useRef, useState, type ReactNode } from "react";
import type { Chat, Project } from "@shared/types";
import { api, toggleTheme, useStore } from "../store";
import { AgentImportDialog } from "./AgentImport";
import { UserAvatar } from "./UserAvatar";
import { openMenu, type MenuItem } from "./ContextMenu";
import {
  Archive, ArchiveRestore, BookOpen, Bot, ChevronRight, ClipboardList, Copy, FolderOpen, FolderPlus, LayoutDashboard, MessageSquarePlus,
  Download, Moon, MoreHorizontal, Pause, Pencil, Pin, PinOff, Plus, Puzzle, RoleIcon, RotateCcw, Settings, SquareKanban, Sun, Trash2, Zap,
} from "./icons";

const byPinned = (a: Chat, b: Chat) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt;

export function Sidebar() {
  const st = useStore();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const running = Object.values(st.agents).filter((a) => a.status === "running" || a.status === "paused").length;
  const view = st.view;
  const isChat = (id: string) => view.kind === "chat" && view.chatId === id;
  const isBusy = (chatId: string) => Object.values(st.agents).some((a) => a.chatId === chatId && a.status === "running");

  const addProject = async () => {
    const path = await api().pickFolder();
    if (!path) return;
    const p = await api().createProject(path);
    await st.refreshProjects();
    await st.refreshChats(p.id);
    setOpen((o) => ({ ...o, [p.id]: true }));
    const first = useStore.getState().chats[p.id]?.[0];
    if (first) await st.openChat(first.id);
  };

  const newChat = async (projectId: string, role = "flashmaster") => {
    const r = st.roles.find((x) => x.name === role);
    const c = await api().createChat({ projectId, agentRole: role, title: role === "flashmaster" ? "New chat" : r?.title ?? role });
    st.upsertChat(c);
    setOpen((o) => ({ ...o, [projectId]: true }));
    await st.openChat(c.id);
  };

  const startSpecialist = async (role: string) => {
    const pid = st.currentProjectId ?? st.projects[0]?.id;
    if (!pid) { st.toast("warn", "Add a project folder first — specialists work inside a project."); return; }
    await newChat(pid, role);
  };

  const patchChat = async (c: Chat, patch: Partial<Pick<Chat, "title" | "archived" | "pinned">>) => {
    const n = await api().updateChat(c.id, patch);
    st.upsertChat(n);
    return n;
  };
  const resetContext = async (c: Chat) => {
    try { await api().resetContext(c.id); st.toast("info", `Context reset for “${c.title}”`); } catch (e: any) { st.toast("warn", String(e?.message ?? e)); }
  };
  const deleteChat = async (c: Chat) => {
    if (!confirm(`Delete “${c.title}” and all its messages? This cannot be undone.`)) return;
    await api().deleteChat(c.id);
    st.removeChat(c);
    if (isChat(c.id) && st.masterChatId) await st.openChat(st.masterChatId);
  };
  const archiveChat = async (c: Chat) => {
    await patchChat(c, { archived: !c.archived, pinned: c.archived ? c.pinned : false });
    if (!c.archived && isChat(c.id) && st.masterChatId) await st.openChat(st.masterChatId);
    st.toast("info", c.archived ? `Restored “${c.title}”` : `Archived “${c.title}”`);
  };

  const chatMenu = (c: Chat): MenuItem[] => [
    { label: "Rename", icon: <Pencil size={15} />, onClick: () => setRenaming(c.id), hint: "F2" },
    { label: c.pinned ? "Unpin" : "Pin to top", icon: c.pinned ? <PinOff size={15} /> : <Pin size={15} />, onClick: () => patchChat(c, { pinned: !c.pinned }), disabled: c.archived },
    { label: "Reset context", icon: <RotateCcw size={15} />, onClick: () => resetContext(c), disabled: isBusy(c.id) },
    { label: "Copy as Markdown", icon: <Copy size={15} />, onClick: async () => { await navigator.clipboard.writeText(await api().exportChat(c.id)); st.toast("info", "Chat copied as Markdown"); } },
    { separator: true, label: "" },
    { label: c.archived ? "Restore from archive" : "Archive", icon: c.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />, onClick: () => archiveChat(c) },
    { label: "Delete", icon: <Trash2 size={15} />, danger: true, onClick: () => deleteChat(c) },
  ];
  const projectMenu = (p: Project): MenuItem[] => {
    const archived = (st.chats[p.id] ?? []).filter((c) => c.archived).length;
    return [
      { label: "New chat", icon: <MessageSquarePlus size={15} />, onClick: () => newChat(p.id) },
      { label: "Rename project", icon: <Pencil size={15} />, onClick: async () => { const n = prompt("Project name", p.name); if (n) { await api().renameProject(p.id, n); await st.refreshProjects(); } } },
      { label: "Open folder", icon: <FolderOpen size={15} />, onClick: () => api().openProjectFolder(p.id) },
      { label: showArchived[p.id] ? "Hide archived chats" : `Show archived chats${archived ? ` (${archived})` : ""}`, icon: <Archive size={15} />, disabled: !archived,
        onClick: () => { setShowArchived((o) => ({ ...o, [p.id]: !o[p.id] })); setOpen((o) => ({ ...o, [p.id]: true })); } },
      { separator: true, label: "" },
      { label: "Remove project", icon: <Trash2 size={15} />, danger: true, hint: "files stay",
        onClick: async () => { if (confirm(`Remove “${p.name}” from TheFlashMaster? Its chats are deleted; the folder on disk is not touched.`)) { await api().removeProject(p.id); await st.refreshProjects(); } } },
    ];
  };

  // Plain render function (not a component defined in render): a component created here would get a new identity on
  // every sidebar re-render (agent status, streaming…) and remount — resetting the rename field to the old title.
  const chatRow = (c: Chat) => (
    renaming === c.id ? (
      <RenameInput key={c.id} initial={c.title} onCancel={() => setRenaming(null)}
        onDone={async (t) => { setRenaming(null); if (t && t !== c.title) await patchChat(c, { title: t }); }} />
    ) : (
      <div key={c.id} className={`chat-link ${isChat(c.id) ? "active" : ""} ${c.archived ? "archived" : ""}`} role="button" tabIndex={0}
        onClick={() => st.openChat(c.id)} onDoubleClick={() => setRenaming(c.id)} onContextMenu={(e) => openMenu(e, chatMenu(c))}
        onKeyDown={(e) => { if (e.key === "F2") setRenaming(c.id); if (e.key === "Enter") void st.openChat(c.id); }}>
        {c.pinned && <Pin size={12} className="chat-pin" />}
        {c.archived && <Archive size={12} className="chat-pin" />}
        <span className="chat-title">{c.title}</span>
        {isBusy(c.id) && <span className="pulse" />}
        <button className="row-more" title="More" onClick={(e) => openMenu(e, chatMenu(c), true)}><MoreHorizontal size={15} /></button>
      </div>
    )
  );

  const openTasks = Object.values(st.tasks).filter((t) => t.status !== "done").length;
  const light = st.settings?.general.theme === "light" || document.documentElement.dataset.theme === "light";

  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Zap size={17} strokeWidth={2.4} /></span> TheFlashMaster</div>

      <nav className="nav">
        <NavBtn active={isChat(st.masterChatId ?? "")} working={Object.values(st.agents).some((a) => a.role === "flashmaster" && a.status === "running")}
          onClick={() => st.masterChatId && st.openChat(st.masterChatId)} icon={<Zap size={17} />} label="Master chat" />
        <NavBtn active={view.kind === "agents"} onClick={() => st.setView({ kind: "agents" })} icon={<Bot size={17} />} label="Agents"
          extra={running > 0 && <span className="badge">{running}</span>} />
        <NavBtn active={view.kind === "dashboard"} onClick={() => st.setView({ kind: "dashboard" })} icon={<LayoutDashboard size={17} />} label="Dashboard" />
        <NavBtn active={view.kind === "tasks"} onClick={() => st.setView({ kind: "tasks" })} icon={<SquareKanban size={17} />} label="Tasks"
          extra={openTasks > 0 && <span className="count">{openTasks}</span>} />
        <NavBtn active={view.kind === "jazz"} onClick={() => st.setView({ kind: "jazz" })} icon={<ClipboardList size={17} />} label="IBM Jazz" />
        <NavBtn active={view.kind === "marketplace"} onClick={() => st.setView({ kind: "marketplace" })} icon={<Puzzle size={17} />} label="Marketplace" />
        <NavBtn active={view.kind === "docs"} onClick={() => st.setView({ kind: "docs" })} icon={<BookOpen size={17} />} label="Documentation" />
      </nav>

      <div className="section-title">
        Projects <button className="icon-btn" title="Add project folder" onClick={addProject}><FolderPlus size={15} /></button>
      </div>
      <div className="projects">
        {st.projects.length === 0 && <div className="empty-hint">Add a local folder to start.</div>}
        {st.projects.map((p) => {
          const chats = (st.chats[p.id] ?? []).filter((c) => !c.archived).sort(byPinned);
          const archived = (st.chats[p.id] ?? []).filter((c) => c.archived);
          return (
            <div key={p.id} className="project">
              <div className={`project-row ${st.currentProjectId === p.id ? "current" : ""}`} onContextMenu={(e) => openMenu(e, projectMenu(p))}>
                <button className="project-name" title={p.path} onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}>
                  <ChevronRight size={14} className={`chev ${open[p.id] ? "open" : ""}`} /> {p.name}
                </button>
                <button className="icon-btn" title="More" onClick={(e) => openMenu(e, projectMenu(p), true)}><MoreHorizontal size={15} /></button>
                <button className="icon-btn" title="New chat" onClick={() => newChat(p.id)}><Plus size={15} /></button>
              </div>
              {open[p.id] && <div className="chat-list">
                {chats.map((c) => chatRow(c))}
                {archived.length > 0 && (
                  <button className="archived-toggle" onClick={() => setShowArchived((o) => ({ ...o, [p.id]: !o[p.id] }))}>
                    <Archive size={12} /> {showArchived[p.id] ? "Hide" : "Show"} archived ({archived.length})
                  </button>
                )}
                {showArchived[p.id] && archived.map((c) => chatRow(c))}
              </div>}
            </div>
          );
        })}
      </div>

      <div className="section-title">
        Specialists <button className="icon-btn" title="Add your own agent (template / import)" onClick={() => setImporting(true)}><Plus size={15} /></button>
      </div>
      <div className="palette">
        {st.roles.filter((r) => r.name !== "flashmaster").map((r) => {
          const mine = Object.values(st.agents).filter((a) => a.role === r.name);
          const working = mine.filter((a) => a.status === "running").length;
          const paused = mine.filter((a) => a.status === "paused").length;
          const busyAgent = mine.find((a) => a.status === "running");
          return (
          <button key={r.name} className={`palette-item ${working ? "is-working" : paused ? "is-paused" : ""}`} title={`${r.description}\n\n${working ? "Working now — click to watch its progress." : `Click: new chat with ${r.title} in the current project.`}\nTip: type @${r.name} in any chat.`}
            onClick={async () => {
              // A working specialist opens its chat with the progress flow; an idle one starts a new chat.
              if (busyAgent?.chatId) { await st.openChat(busyAgent.chatId); st.openFlow(busyAgent.chatId, busyAgent.id); } else await startSpecialist(r.name);
            }}>
            <span className="palette-icon"><RoleIcon role={r.name} emoji={r.icon} size={24} className="icon-glyph" />{(working > 0 || paused > 0) && <span className="activity-ring" />}</span>
            <span className="palette-title">{r.title}</span>
            {working > 0 && <span className="working-dots" title={`${working} working${busyAgent?.lastActivity ? ` — ${busyAgent.lastActivity}` : ""}`}><i /><i /><i />{working > 1 && <b>{working}</b>}</span>}
            {!working && paused > 0 && <span className="paused-tag" title={`${paused} paused`}><Pause size={12} /></span>}
            {r.source === "user" && <span className="custom-tag">custom</span>}
          </button>
          );
        })}
      </div>

      {importing && <AgentImportDialog onClose={() => setImporting(false)} />}
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
        <button className="theme-toggle" title={light ? "Switch to dark mode" : "Switch to light mode"} onClick={() => void toggleTheme()}>
          <span key={light ? "moon" : "sun"} className="theme-icon">{light ? <Moon size={17} /> : <Sun size={17} />}</span>
        </button>
      </div>
    </aside>
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
