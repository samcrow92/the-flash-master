import { create } from "zustand";
import type { AgentRun, AppEvent, Chat, CodeGraphStatus, HarnessId, HarnessModels, McpServerStatus, Message, Project, RoleDef, SearchHit, SkillDef, Task, CopilotUsage, UpdateState, WindowState } from "@shared/types";
import type { Settings } from "@shared/settings";
import { chatKey, pickAgentChat } from "./agentChat";
import { agentLabel } from "@shared/instances";
import { uniqueModels } from "@shared/models";

export const api = () => window.flash.api;

export type View =
  | { kind: "chat"; chatId: string }
  | { kind: "agents" }
  | { kind: "review"; agentId?: string }
  | { kind: "dashboard" }
  | { kind: "tasks" }
  | { kind: "memory" }
  | { kind: "jazz" }
  | { kind: "settings"; tab?: string }
  | { kind: "flow"; agentId: string }
  | { kind: "timeline"; traceId?: string }
  | { kind: "evals" }
  | { kind: "traceability" }
  | { kind: "marketplace" }
  | { kind: "docs"; page?: string };

export interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

interface State {
  ready: boolean;
  /** The app window (custom title bar, glass material). */
  window: WindowState | null;
  view: View;
  projects: Project[];
  chats: Record<string, Chat[]>; // projectId → chats
  chatById: Record<string, Chat>;
  masterChatId: string | null;
  currentProjectId: string | null;
  messages: Record<string, Message[]>; // chatId → main-thread messages
  /** Thread messages per root (root first, then replies), loaded on first open and kept live by events. */
  threads: Record<string, Message[]>;
  /** A thread for the panel to scroll to once it is shown (`reply`: also focus its reply box); `at` makes repeat requests fire again. */
  /** The chat last opened in each project (key: chatKey(projectId)), which the project's sidebar row reopens. */
  lastChatByProject: Record<string, string>;
  /** The sidebar is folded away (title bar button or Ctrl/Cmd+B); remembered across launches. */
  sidebarCollapsed: boolean;
  flowPanel: { chatId: string; agentId: string | null } | null;
  artifactsPanel: string | null; // chat id whose artifacts panel is open
  artifactsRev: Record<string, number>;
  /** Bumped on every memory change (Memory page reloads). */
  memoryRev: number;
  /** Code graph (graphify) per project, as the last scan event left it. */
  codeGraph: Record<string, CodeGraphStatus>;
  openFlow(chatId: string, agentId: string | null): void;
  agents: Record<string, AgentRun>;
  tasks: Record<string, Task>;
  roles: RoleDef[];
  skills: SkillDef[];
  settings: Settings | null;
  locked: string[];
  mcp: McpServerStatus[];
  models: Partial<Record<HarnessId, HarnessModels>>;
  copilotUsage: CopilotUsage | null;
  update: UpdateState | null;
  setModels(m: HarnessModels): void;
  toasts: Toast[];
  /** The chat search window (Ctrl/Cmd+Shift+F). */
  searchOpen: boolean;
  /** A message to scroll to and flash (from search); `at` makes repeat jumps to the same message fire again. */
  focusMessage: { id: string; rootId: string | null; at: number } | null;
  /** Open a search hit: its chat, its thread when it is a reply, then scroll to it. */
  jumpTo(hit: Pick<SearchHit, "chatId" | "messageId" | "parentId">): Promise<void>;

  /** `chatId`: a popped-out chat window, which opens that chat instead of the last one and doesn't change what the main window restores. */
  init(opts?: { chatId?: string }): Promise<void>;
  setView(v: View): void;
  /** `remember: false` keeps the chat out of "restore last chat" (popped-out windows). */
  openChat(chatId: string, opts?: { remember?: boolean }): Promise<void>;
  /** Open the agent's chat (where it works now, its latest chat, or a new one); `showFlow: false` skips the progress overlay. */
  chatWithAgent(role: string, opts?: { showFlow?: boolean }): Promise<void>;
  /** Open the agent's dedicated chat in its own window (creating the chat if it has none); focuses the window if already open. */
  openAgentWindow(role: string): Promise<void>;
  toggleSidebar(collapsed?: boolean): void;
  refreshProjects(): Promise<void>;
  /** Reload one project's chats, or (null) the chats that belong to no project. */
  refreshChats(projectId: string | null): Promise<void>;
  upsertChat(c: Chat): void;
  removeChat(c: Chat): void;
  setSettings(s: Settings): void;
  toast(level: Toast["level"], text: string): void;
  apply(e: AppEvent): void;
}

let toastId = 0;


const LAST_CHATS = "lastChatByProject";
/** The chat last opened in each project, kept across launches so a project row reopens where you left off. */
function readLastChats(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(LAST_CHATS) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, id]) => typeof id === "string")) as Record<string, string> : {};
  } catch { return {}; }
}

const SIDEBAR_PREF = "sidebarCollapsed";
export function readSidebarPref(): boolean {
  try { return globalThis.localStorage?.getItem(SIDEBAR_PREF) === "1"; } catch { return false; }
}

const bySeq = (a: Message, b: Message) => a.seq - b.seq;
const upsertMsg = (list: Message[], m: Message) => {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) { const copy = list.slice(); copy[i] = m; return copy; }
  // Insert by server order (events can interleave with a reload).
  const at = list.findIndex((x) => x.seq > m.seq);
  return at < 0 ? [...list, m] : [...list.slice(0, at), m, ...list.slice(at)];
};
/** Merge a freshly loaded list with what is on screen: server order wins; a streaming bubble keeps the longer text. */
const mergeLoaded = (loaded: Message[], shown: Message[] | undefined): Message[] => {
  if (!shown?.length) return loaded.slice().sort(bySeq);
  const byId = new Map(shown.map((m) => [m.id, m]));
  const merged = loaded.map((m) => {
    const cur = byId.get(m.id);
    return cur && m.status === "streaming" && cur.content.length > m.content.length ? { ...m, content: cur.content } : m;
  });
  for (const m of shown) if (!merged.some((x) => x.id === m.id) && m.seq > (loaded.at(-1)?.seq ?? 0)) merged.push(m);
  return merged.sort(bySeq);
};
const patchMsg = (list: Message[] | undefined, id: string, fn: (m: Message) => Message) =>
  list ? list.map((m) => (m.id === id ? fn(m) : m)) : list;

/** Apply a patch to a message wherever it sits in the loaded threads (unchanged lists keep their identity). */
const patchThreads = (threads: Record<string, Message[]>, id: string, fn: (m: Message) => Message) => {
  let out = threads;
  for (const [root, list] of Object.entries(threads)) {
    if (!list.some((m) => m.id === id)) continue;
    out = { ...out, [root]: list.map((m) => (m.id === id ? fn(m) : m)) };
  }
  return out;
};

export const useStore = create<State>((set, get) => ({
  ready: false,
  window: null,
  view: { kind: "dashboard" },
  projects: [],
  chats: {},
  chatById: {},
  masterChatId: null,
  currentProjectId: null,
  messages: {},
  threads: {},
  lastChatByProject: readLastChats(),
  sidebarCollapsed: readSidebarPref(),
  flowPanel: null,
  artifactsPanel: null,
  artifactsRev: {},
  memoryRev: 0,
  codeGraph: {},
  agents: {},
  tasks: {},
  roles: [],
  skills: [],
  settings: null,
  locked: [],
  mcp: [],
  models: {},
  copilotUsage: null,
  update: null,
  setModels(m) {
    // Lists cached by an older version can still hold duplicate ids.
    set((st) => ({ models: { ...st.models, [m.harness]: { ...m, models: uniqueModels(m.models) } } }));
  },
  toasts: [],
  searchOpen: false,
  focusMessage: null,

  async jumpTo(hit) {
    set({ searchOpen: false });
    await get().openChat(hit.chatId);
    set({ focusMessage: { id: hit.messageId, rootId: hit.parentId, at: Date.now() } });
  },

  async init(opts) {
    const a = api();
    const [projects, master, roles, skills, s, agents, tasks, mcp, models] = await Promise.all([
      a.listProjects(), a.getMasterChat(), a.listRoles(), a.listSkills(), a.getSettings(), a.listAgents({}), a.listTasks({}), a.mcpStatus(), a.allModels(),
    ]);
    void a.copilotUsage(false).then((u) => set({ copilotUsage: u })).catch(() => undefined);
    void a.updateState().then((u) => set({ update: u })).catch(() => undefined);
    set({
      projects, masterChatId: master.id, chatById: { [master.id]: master }, roles, skills, settings: s.settings, locked: s.locked,
      agents: Object.fromEntries(agents.map((x) => [x.id, x])), tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), mcp,
      models: Object.fromEntries(models.filter((m) => m.fetchedAt).map((m) => [m.harness, m])),
    });
    await Promise.all([...projects.map((p) => get().refreshChats(p.id)), get().refreshChats(null)]);
    applyTheme(s.settings.general.theme);
    set({ ready: true });
    let last: string | null = null;
    try { last = localStorage.getItem("lastChat"); } catch { /* storage unavailable */ }
    if (opts?.chatId) { await get().openChat(opts.chatId, { remember: false }); return; }
    await get().openChat(s.settings.general.restoreLastChat && last && get().chatById[last] ? last : master.id);
  },

  setView(v) {
    set({ view: v });
  },

  async openChat(chatId, opts) {
    const chat = get().chatById[chatId];
    set({ view: { kind: "chat", chatId }, flowPanel: get().flowPanel?.chatId === chatId ? get().flowPanel : null,
      // The master chat and "No project" chats have no project: don't keep the last one, or new agents would land in it.
      artifactsPanel: get().artifactsPanel === chatId ? chatId : null, currentProjectId: chat ? chat.projectId : get().currentProjectId,
      lastChatByProject: chat && chat.kind !== "master" ? { ...get().lastChatByProject, [chatKey(chat.projectId)]: chatId } : get().lastChatByProject });
    if (opts?.remember !== false) try { localStorage.setItem("lastChat", chatId); localStorage.setItem(LAST_CHATS, JSON.stringify(get().lastChatByProject)); } catch { /* storage unavailable */ }
    const msgs = await api().listMessages(chatId, null);
    set((st) => ({ messages: { ...st.messages, [chatId]: mergeLoaded(msgs, st.messages[chatId]) } }));
  },

  async chatWithAgent(role, opts) {
    const st = get();
    const t = pickAgentChat(role, { agents: st.agents, chats: st.chats, projectIds: st.projects.map((p) => p.id),
      currentProjectId: st.currentProjectId, masterChatId: st.masterChatId });
    if (t.kind === "open") {
      await st.openChat(t.chatId);
      if (t.agentId && opts?.showFlow !== false) st.openFlow(t.chatId, t.agentId);
      return;
    }
    const r = st.roles.find((x) => x.name === role);
    const c = await api().createChat({ projectId: t.projectId, agentRole: role, title: r?.title ?? role });
    st.upsertChat(c);
    await st.openChat(c.id);
  },

  async openAgentWindow(role) {
    const st = get();
    const t = pickAgentChat(role, { agents: st.agents, chats: st.chats, projectIds: st.projects.map((p) => p.id),
      currentProjectId: st.currentProjectId, masterChatId: st.masterChatId }, { dedicated: true });
    let chatId: string;
    if (t.kind === "open") chatId = t.chatId;
    else {
      const r = st.roles.find((x) => x.name === role);
      const c = await api().createChat({ projectId: t.projectId, agentRole: role, title: r?.title ?? role });
      st.upsertChat(c);
      chatId = c.id;
    }
    await api().openChatWindow(chatId);
  },

  toggleSidebar(collapsed) {
    const next = collapsed ?? !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    try { globalThis.localStorage?.setItem(SIDEBAR_PREF, next ? "1" : "0"); } catch { /* storage unavailable */ }
  },
  openFlow(chatId, agentId) {
    set({ flowPanel: { chatId, agentId }, artifactsPanel: null });
  },

  async refreshProjects() {
    set({ projects: await api().listProjects() });
  },

  async refreshChats(projectId) {
    const list = await api().listChats(projectId);
    set((st) => ({ chats: { ...st.chats, [chatKey(projectId)]: list }, chatById: { ...st.chatById, ...Object.fromEntries(list.map((c) => [c.id, c])) } }));
  },

  upsertChat(c) {
    // The master chat has its own nav entry; it is not one of the "No project" chats.
    if (c.kind === "master") { set((st) => ({ chatById: { ...st.chatById, [c.id]: c } })); return; }
    set((st) => {
      const key = chatKey(c.projectId);
      const list = st.chats[key] ?? [];
      const i = list.findIndex((x) => x.id === c.id);
      const next = i < 0 ? [...list, c] : list.map((x) => (x.id === c.id ? c : x));
      return { chats: { ...st.chats, [key]: next }, chatById: { ...st.chatById, [c.id]: c } };
    });
  },

  removeChat(c) {
    set((st) => {
      const key = chatKey(c.projectId);
      const { [c.id]: _gone, ...rest } = st.chatById;
      return { chats: { ...st.chats, [key]: (st.chats[key] ?? []).filter((x) => x.id !== c.id) }, chatById: rest };
    });
  },

  setSettings(s) {
    set({ settings: s });
    applyTheme(s.general.theme);
  },

  toast(level, text) {
    const id = ++toastId;
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, level, text }] }));
    setTimeout(() => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })), level === "error" ? 9000 : 5000);
  },

  apply(e) {
    const st = get();
    switch (e.type) {
      case "chat.upserted": st.upsertChat(e.chat); return;
      case "message.created": {
        const m = e.message;
        if (!st.chatById[m.chatId]) {
          // A chat created in the main process (e.g. startAgent): reload the chat lists.
          for (const p of st.projects) void st.refreshChats(p.id);
          void st.refreshChats(null);
        }
        if (m.parentId === null) {
          if (st.messages[m.chatId]) set({ messages: { ...st.messages, [m.chatId]: upsertMsg(st.messages[m.chatId]!, m) } });
        } else {
          const root = m.parentId;
          set({
            messages: { ...st.messages, [m.chatId]: patchMsg(st.messages[m.chatId], root, (r) => ({ ...r, replyCount: r.replyCount + 1, threadArchived: undefined })) ?? [] },
            threads: st.threads[root] ? { ...st.threads, [root]: upsertMsg(st.threads[root], m) } : st.threads,
          });
        }
        break;
      }
      case "message.delta": {
        const add = (m: Message) => ({ ...m, content: m.content + e.delta });
        set({
          messages: { ...st.messages, [e.chatId]: patchMsg(st.messages[e.chatId], e.messageId, add) ?? [] },
          threads: patchThreads(st.threads, e.messageId, add),
        });
        break;
      }
      case "message.tools": {
        const add = (m: Message) => ({ ...m, tools: e.tools });
        set({
          messages: { ...st.messages, [e.chatId]: patchMsg(st.messages[e.chatId], e.messageId, add) ?? [] },
          threads: patchThreads(st.threads, e.messageId, add),
        });
        break;
      }
      case "message.updated": {
        const m = e.message;
        const keep = (old: Message) => ({ ...m, replyCount: Math.max(old.replyCount, m.replyCount) });
        set({
          messages: { ...st.messages, [m.chatId]: patchMsg(st.messages[m.chatId], m.id, keep) ?? [] },
          threads: patchThreads(st.threads, m.id, keep),
        });
        break;
      }
      case "messages.removed": {
        const gone = new Set(e.removed.map((r) => r.id));
        const lost = new Map<string, number>(); // thread root → replies removed from it
        for (const r of e.removed) if (r.parentId && !gone.has(r.parentId)) lost.set(r.parentId, (lost.get(r.parentId) ?? 0) + 1);
        const keep = (list: Message[]) => list.filter((m) => !gone.has(m.id))
          .map((m) => (lost.has(m.id) ? { ...m, replyCount: Math.max(0, m.replyCount - lost.get(m.id)!) } : m));
        const threads: Record<string, Message[]> = {};
        for (const [root, list] of Object.entries(st.threads)) if (!gone.has(root)) threads[root] = keep(list);
        set({ messages: st.messages[e.chatId] ? { ...st.messages, [e.chatId]: keep(st.messages[e.chatId]!) } : st.messages, threads });
        break;
      }
      case "reaction.changed": {
        const r = (m: Message) => ({ ...m, reactions: e.reactions });
        set({
          messages: { ...st.messages, [e.chatId]: patchMsg(st.messages[e.chatId], e.messageId, r) ?? [] },
          threads: patchThreads(st.threads, e.messageId, r),
        });
        break;
      }
      case "agent.updated":
        set({ agents: { ...st.agents, [e.agent.id]: e.agent } });
        break;
      case "task.updated":
        set({ tasks: { ...st.tasks, [e.task.id]: e.task } });
        break;
      case "task.deleted": {
        const { [e.taskId]: _x, ...rest } = st.tasks;
        set({ tasks: rest });
        break;
      }
      case "mcp.status":
        set({ mcp: e.servers });
        break;
      case "models.updated":
        st.setModels(e.models);
        break;
      case "update.state":
        set({ update: e.state });
        break;
      case "memory.changed":
        set((s2) => ({ memoryRev: s2.memoryRev + 1 }));
        break;
      case "codegraph.changed":
        set((s2) => ({ codeGraph: { ...s2.codeGraph, [e.status.projectId]: e.status } }));
        break;
      case "artifacts.changed":
        set((s2) => ({ artifactsRev: { ...s2.artifactsRev, [e.chatId]: (s2.artifactsRev[e.chatId] ?? 0) + 1 } }));
        break;
      case "copilotUsage.updated":
        set({ copilotUsage: e.usage });
        break;
      case "roles.changed":
        set({ roles: e.roles });
        break;
      case "plugins.changed":
        void api().listSkills().then((skills) => set({ skills }));
        break;
      case "window.state":
        set({ window: e.state });
        applyWindow(e.state);
        break;
      case "notice":
        st.toast(e.level, e.text);
        break;
    }
  },
}));

/** Root attributes the glass styles key off: platform, native material, focus (dims the chrome like macOS), maximised. */
export function applyWindow(w: WindowState): void {
  const d = document.documentElement.dataset;
  d.platform = w.platform;
  d.material = w.material;
  d.focused = String(w.focused);
  d.maximized = String(w.maximized || w.fullscreen);
}

let currentTheme: "dark" | "light" | "system" = "dark";
export function applyTheme(theme: "dark" | "light" | "system"): void {
  currentTheme = theme;
  const t = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = t;
}
// "System" follows Windows' light/dark setting live.
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (currentTheme === "system") applyTheme("system"); });

/** One-click switch used by the sidebar: flips between light and dark (leaving "system" for Settings). */
export async function toggleTheme(): Promise<void> {
  const shown = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const next = shown === "light" ? "dark" : "light";
  useStore.getState().setSettings(await api().updateSettings({ general: { theme: next } }));
}

export function roleOf(name: string | null | undefined): RoleDef | undefined {
  return useStore.getState().roles.find((r) => r.name === name);
}

/** "Nova · Coder" for a named specialist instance, else the role title. */
export function agentTitle(a: Pick<AgentRun, "role" | "name"> | null | undefined, fallback = "agent"): string {
  if (!a) return fallback;
  return agentLabel(a, roleOf(a.role)?.title ?? a.role);
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
