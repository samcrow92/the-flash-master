import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { api, toggleTheme, useStore, type View } from "../store";
import { chatOrder, matchShortcut, rankCommands, SHORTCUTS, shortcutLabel, stepChat, type Command, type ShortcutId } from "../commands";
import { TABS as SETTINGS_TABS } from "../views/SettingsView";
import { useMenu } from "./ContextMenu";
import { toggleTerminal } from "./TerminalPanel";
import {
  BookOpen, Bot, ClipboardList, GitBranch, LayoutDashboard, MessageSquare, MessageSquarePlus, Puzzle, Search, Settings, SquareKanban, Square, SquareTerminal, SunMoon, TextCursorInput, Zap, RoleIcon,
} from "./icons";

export const usePalette = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

const isMac = () => {
  const p = useStore.getState().window?.platform;
  return p ? p === "darwin" : /mac/i.test(navigator.platform);
};

/** Focus the open chat's message box (the Composer listens for this). */
export const focusComposer = (): void => { setTimeout(() => window.dispatchEvent(new Event("flash:focus-composer")), 0); };

const runningInChat = (chatId: string) =>
  Object.values(useStore.getState().agents).filter((a) => a.chatId === chatId && (a.status === "running" || a.status === "paused"));

async function stopChat(chatId: string): Promise<boolean> {
  const running = runningInChat(chatId);
  if (!running.length) return false;
  await Promise.all(running.map((a) => api().stopAgent(a.id).catch(() => undefined)));
  useStore.getState().toast("info", running.length === 1 ? "Stopped the agent" : `Stopped ${running.length} agents`);
  return true;
}

async function newChat(): Promise<void> {
  const st = useStore.getState();
  // No project selected: the chat goes to "No project", never into the first project in the list.
  const projectId = st.currentProjectId;
  const c = await api().createChat({ projectId, agentRole: "flashmaster", title: "New chat" });
  st.upsertChat(c);
  await st.openChat(c.id);
  focusComposer();
}

function runShortcut(id: ShortcutId): void {
  const st = useStore.getState();
  const chatId = st.view.kind === "chat" ? st.view.chatId : null;
  switch (id) {
    case "palette": usePalette.getState().setOpen(!usePalette.getState().open); break;
    case "newChat": void newChat().catch((e) => st.toast("error", String(e?.message ?? e))); break;
    case "settings": st.setView({ kind: "settings" }); break;
    case "focusComposer": if (chatId) focusComposer(); break;
    case "prevChat": case "nextChat": {
      const next = stepChat(chatOrder(st.masterChatId, st.projects.map((p) => p.id), st.chats), chatId, id === "nextChat" ? 1 : -1);
      if (next) void st.openChat(next);
      break;
    }
    case "stop": if (chatId) void stopChat(chatId); break;
    case "search": usePalette.getState().setOpen(false); useStore.setState((s) => ({ searchOpen: !s.searchOpen })); break;
  }
}

/** Something else on screen owns Esc (a dialog, an image viewer, a menu, a field being edited). */
function escTaken(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || usePalette.getState().open || useMenu.getState().open) return true;
  if (document.querySelector(".modal-back, .viewer")) return true;
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
}

/** App-wide shortcuts: one keydown listener on the window, bubbling, so fields that handle a key first can claim it. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !useStore.getState().ready) return;
      // Keys typed in the integrated terminal belong to the shell (Ctrl+K, Ctrl+L, Esc in vim…), never to app shortcuts.
      if (e.target instanceof Element && e.target.closest(".term-panel")) return;
      const id = matchShortcut(e, isMac());
      if (!id) return;
      if (id === "stop") {
        if (escTaken(e)) return;
        const st = useStore.getState();
        if (st.view.kind !== "chat" || !runningInChat(st.view.chatId).length) return;
      } else if (id !== "palette" && usePalette.getState().open) return;
      // Alt+↑/↓ inside a multi-line message moves the caret in some apps; only take it when the box is empty or not focused.
      if ((id === "prevChat" || id === "nextChat") && e.target instanceof HTMLTextAreaElement && e.target.value) return;
      e.preventDefault();
      runShortcut(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

interface Item extends Command { icon: ReactNode; run: () => void | Promise<void>; shortcut?: ShortcutId }

/** Ctrl/Cmd+K: jump to any chat, agent, page or setting, or run an action, by typing a few letters. */
export function CommandPalette() {
  const { open, setOpen } = usePalette();
  if (!open) return null;
  return <PaletteBox onClose={() => setOpen(false)} />;
}

function PaletteBox({ onClose }: { onClose: () => void }) {
  const st = useStore();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const mac = isMac();
  const currentChat = st.view.kind === "chat" ? st.view.chatId : null;

  const items = useMemo<Item[]>(() => {
    const go = (v: View) => () => st.setView(v);
    const projectName = (id: string | null) => st.projects.find((p) => p.id === id)?.name ?? "";
    const actions: Item[] = [
      { id: "a:new", group: "Action", label: "New chat", keywords: "create start", icon: <MessageSquarePlus size={16} />, run: () => runShortcut("newChat"), shortcut: "newChat" },
      ...(currentChat && runningInChat(currentChat).length ? [{ id: "a:stop", group: "Action", label: "Stop agents in this chat", keywords: "cancel halt", icon: <Square size={14} />, run: () => runShortcut("stop"), shortcut: "stop" as const }] : []),
      ...(currentChat ? [{ id: "a:focus", group: "Action", label: "Focus the message box", keywords: "composer type write", icon: <TextCursorInput size={16} />, run: focusComposer, shortcut: "focusComposer" as const }] : []),
      { id: "a:search", group: "Action", label: "Search all chats", keywords: "find messages history", icon: <Search size={16} />, run: () => runShortcut("search"), shortcut: "search" },
      { id: "a:terminal", group: "Action", label: "Show or hide the terminal", keywords: "shell console powershell command line", icon: <SquareTerminal size={16} />, run: () => toggleTerminal() },
      { id: "a:theme", group: "Action", label: "Switch light / dark theme", keywords: "appearance mode", icon: <SunMoon size={16} />, run: () => toggleTheme() },
    ];
    const order = chatOrder(st.masterChatId, st.projects.map((p) => p.id), st.chats);
    const archived = Object.values(st.chats).flat().filter((c) => c.archived).map((c) => c.id);
    const chats: Item[] = [...order, ...archived].filter((id) => id !== currentChat && st.chatById[id]).map((id) => {
      const c = st.chatById[id]!;
      const master = id === st.masterChatId;
      return { id: `c:${id}`, group: "Chat", label: master ? "Master chat" : c.title, hint: master ? "" : `${projectName(c.projectId)}${c.archived ? " · archived" : ""}`,
        keywords: `${c.agentRole} ${projectName(c.projectId)}`, icon: master ? <Zap size={16} /> : <MessageSquare size={16} />, run: () => st.openChat(id) };
    });
    const agents: Item[] = st.roles.map((r) => ({
      id: `r:${r.name}`, group: "Agent", label: `Chat with ${r.title}`, keywords: `@${r.name} ${r.description}`, icon: <RoleIcon role={r.name} size={18} />, run: () => st.chatWithAgent(r.name),
    }));
    const pages: Item[] = [
      { id: "p:agents", group: "Go to", label: "Agents", icon: <Bot size={16} />, run: go({ kind: "agents" }) },
      { id: "p:review", group: "Go to", label: "Review changes", keywords: "diff merge discard branch worktree", icon: <GitBranch size={16} />, run: go({ kind: "review" }) },
      { id: "p:dash", group: "Go to", label: "Dashboard", icon: <LayoutDashboard size={16} />, run: go({ kind: "dashboard" }) },
      { id: "p:tasks", group: "Go to", label: "Tasks", icon: <SquareKanban size={16} />, run: go({ kind: "tasks" }) },
      { id: "p:jazz", group: "Go to", label: "IBM Jazz", keywords: "requirements", icon: <ClipboardList size={16} />, run: go({ kind: "jazz" }) },
      { id: "p:market", group: "Go to", label: "Marketplace", keywords: "plugins skills", icon: <Puzzle size={16} />, run: go({ kind: "marketplace" }) },
      { id: "p:docs", group: "Go to", label: "Documentation", keywords: "help docs", icon: <BookOpen size={16} />, run: go({ kind: "docs" }) },
    ];
    const settings: Item[] = SETTINGS_TABS.map(([tab, label]) => ({
      id: `s:${tab}`, group: "Settings", label: `Settings · ${label}`, keywords: `preferences ${tab}`, icon: <Settings size={16} />,
      run: go({ kind: "settings", tab }), shortcut: tab === "general" ? "settings" as const : undefined,
    }));
    return [...actions, ...chats, ...agents, ...pages, ...settings];
  }, [st, currentChat]);

  const shown = useMemo(() => rankCommands(items, query), [items, query]);
  const pick = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    void Promise.resolve(it.run()).then(() => { if (it.id.startsWith("c:")) focusComposer(); })
      .catch((e) => useStore.getState().toast("error", String(e?.message ?? e)));
  };
  useEffect(() => { list.current?.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" }); }, [sel, shown]);

  return (
    <div className="palette-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="pal-input">
          <Search size={16} />
          <input autoFocus value={query} placeholder="Jump to a chat, agent, page or setting…" spellCheck={false}
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); pick(shown[sel]); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={list}>
          {shown.length === 0 && <div className="pal-empty">Nothing matches “{query}”</div>}
          {shown.map((it, i) => (
            <button key={it.id} className={`pal-item ${i === sel ? "sel" : ""}`} onMouseMove={() => setSel(i)} onClick={() => pick(it)}>
              <span className="pal-icon">{it.icon}</span>
              <span className="pal-label">{it.label}{it.hint && <span className="pal-hint">{it.hint}</span>}</span>
              {it.shortcut ? <kbd>{shortcutLabel(SHORTCUTS[it.shortcut].keys, mac)}</kbd> : <span className="pal-group">{it.group}</span>}
            </button>
          ))}
        </div>
        <div className="pal-foot">
          {(["newChat", "prevChat", "nextChat", "focusComposer", "stop"] as const).map((k) => (
            <span key={k}><kbd>{shortcutLabel(SHORTCUTS[k].keys, mac)}</kbd> {SHORTCUTS[k].label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
