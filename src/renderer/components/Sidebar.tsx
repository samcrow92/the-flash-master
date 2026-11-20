import { ResizeHandle } from "./ResizeHandle";
import { useRef, useState, type ReactNode } from "react";
import type { Project } from "@shared/types";
import { api, useStore } from "../store";
import { UserAvatar } from "./UserAvatar";
import { openMenu, type MenuItem } from "./ContextMenu";
import { Brain,
  BookOpen, Bot, ClipboardList, Folder, FolderOpen, FolderPlus, LayoutDashboard, MessageSquarePlus,
  Download, GitBranch, MoreHorizontal, Pencil, Plus, Puzzle, Search, Settings, SquareKanban, Trash2, Zap,
} from "./icons";
import { SHORTCUTS, shortcutLabel } from "../commands";
import { chatKey, NO_PROJECT } from "../agentChat";
import { newChatIn, openProjectChat } from "../chatNav";

/**
 * Navigation and projects. Chats are not listed here: a project row reopens the chat you last had open in it, and you
 * move between chats with the switcher under the chat's title or with search (Ctrl/Cmd+K).
 */
export function Sidebar() {
  const st = useStore();
  const [renaming, setRenaming] = useState<string | null>(null);
  const running = Object.values(st.agents).filter((a) => a.status === "running" || a.status === "paused").length;
  const toReview = Object.values(st.agents).filter((a) => a.branch && a.worktree && a.status !== "running").length;
  const view = st.view;
  const isChat = (id: string) => view.kind === "chat" && view.chatId === id;
  const inChat = view.kind === "chat" && !isChat(st.masterChatId ?? "");
  // A project shows a pulse while an agent works in any of its chats.
  const busyKeys = new Set(Object.values(st.agents).filter((a) => a.status === "running" && a.chatId).map((a) => chatKey(st.chatById[a.chatId!]?.projectId ?? null)));

  const addProject = async () => {
    const path = await api().pickFolder();
    if (!path) return;
    const p = await api().createProject(path);
    await st.refreshProjects();
    await st.refreshChats(p.id);
    await openProjectChat(p.id);
  };
  const fail = (e: any) => st.toast("error", String(e?.message ?? e));

  const projectMenu = (p: Project): MenuItem[] => [
    { label: "New chat", icon: <MessageSquarePlus size={15} />, onClick: () => void newChatIn(p.id).catch(fail) },
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
          <div key={p.id} className={`project-row ${inChat && st.currentProjectId === p.id ? "current" : ""}`} onContextMenu={(e) => openMenu(e, projectMenu(p))}>
            {renaming === `project:${p.id}` ? (
              // window.prompt() isn't supported in Electron: rename inline.
              <RenameInput key={`project:${p.id}`} initial={p.name} onCancel={() => setRenaming(null)}
                onDone={async (n) => { setRenaming(null); if (n && n !== p.name) { await api().renameProject(p.id, n); await st.refreshProjects(); } }} />
            ) : (
              <button className="project-name" title={`${p.path}\nOpens the chat you last had open here`} onClick={() => void openProjectChat(p.id).catch(fail)}
                onDoubleClick={() => setRenaming(`project:${p.id}`)} onKeyDown={(e) => { if (e.key === "F2") setRenaming(`project:${p.id}`); }}>
                <Folder size={15} className="project-icon" /> <span className="project-label">{p.name}</span>
                {busyKeys.has(p.id) && <span className="pulse" title="An agent is working here" />}
              </button>
            )}
            <button className="icon-btn" title="More" onClick={(e) => openMenu(e, projectMenu(p), true)}><MoreHorizontal size={15} /></button>
            <button className="icon-btn" title="New chat" onClick={() => void newChatIn(p.id).catch(fail)}><Plus size={15} /></button>
          </div>
        ))}
        <NoProjectSection count={(st.chats[NO_PROJECT] ?? []).filter((c) => !c.archived).length} current={inChat && st.currentProjectId === null}
          busy={busyKeys.has(NO_PROJECT)} onOpen={() => void openProjectChat(null).catch(fail)} />
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

/** Agents and chats whose project couldn't be determined (started from the master chat with no project selected): one row like a project. */
function NoProjectSection({ count, current, busy, onOpen }: { count: number; current: boolean; busy: boolean; onOpen: () => void }) {
  if (!count) return null;
  return (
    <div className={`project-row no-project ${current ? "current" : ""}`}>
      <button className="project-name" title="Chats and agents that don't belong to a project" onClick={onOpen}>
        <Folder size={15} className="project-icon" /> <span className="project-label">No project</span>
        {busy && <span className="pulse" title="An agent is working here" />}
      </button>
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
