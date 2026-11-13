import { create } from "zustand";
import type { AgentRun, AppEvent, Chat, McpServerStatus, Message, Project, RoleDef, SkillDef, Task } from "@shared/types";
import type { Settings } from "@shared/settings";

export const api = () => window.flash.api;

export type View =
  | { kind: "chat"; chatId: string }
  | { kind: "agents" }
  | { kind: "dashboard" }
  | { kind: "tasks" }
  | { kind: "jazz" }
  | { kind: "settings"; tab?: string }
  | { kind: "flow"; agentId: string };

export interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

interface State {
  ready: boolean;
  view: View;
  projects: Project[];
  chats: Record<string, Chat[]>; // projectId → chats
  chatById: Record<string, Chat>;
  masterChatId: string | null;
  currentProjectId: string | null;
  messages: Record<string, Message[]>; // chatId → main-thread messages
  thread: { chatId: string; rootId: string; messages: Message[] } | null;
  flowPanel: { chatId: string; agentId: string | null } | null;
  openFlow(chatId: string, agentId: string | null): void;
  agents: Record<string, AgentRun>;
  tasks: Record<string, Task>;
  roles: RoleDef[];
  skills: SkillDef[];
  settings: Settings | null;
  locked: string[];
  mcp: McpServerStatus[];
  toasts: Toast[];

  init(): Promise<void>;
  setView(v: View): void;
  openChat(chatId: string): Promise<void>;
  openThread(chatId: string, rootId: string): Promise<void>;
  closeThread(): void;
  refreshProjects(): Promise<void>;
  refreshChats(projectId: string): Promise<void>;
  upsertChat(c: Chat): void;
  removeChat(c: Chat): void;
  setSettings(s: Settings): void;
  toast(level: Toast["level"], text: string): void;
  apply(e: AppEvent): void;
}

let toastId = 0;

const upsertMsg = (list: Message[], m: Message) => {
  const i = list.findIndex((x) => x.id === m.id);
  if (i < 0) return [...list, m];
  const copy = list.slice();
  copy[i] = m;
  return copy;
};
const patchMsg = (list: Message[] | undefined, id: string, fn: (m: Message) => Message) =>
  list ? list.map((m) => (m.id === id ? fn(m) : m)) : list;

export const useStore = create<State>((set, get) => ({
  ready: false,
  view: { kind: "dashboard" },
  projects: [],
  chats: {},
  chatById: {},
  masterChatId: null,
  currentProjectId: null,
  messages: {},
  thread: null,
  flowPanel: null,
  agents: {},
  tasks: {},
  roles: [],
  skills: [],
  settings: null,
  locked: [],
  mcp: [],
  toasts: [],

  async init() {
    const a = api();
    const [projects, master, roles, skills, s, agents, tasks, mcp] = await Promise.all([
      a.listProjects(), a.getMasterChat(), a.listRoles(), a.listSkills(), a.getSettings(), a.listAgents({}), a.listTasks({}), a.mcpStatus(),
    ]);
    set({
      projects, masterChatId: master.id, chatById: { [master.id]: master }, roles, skills, settings: s.settings, locked: s.locked,
      agents: Object.fromEntries(agents.map((x) => [x.id, x])), tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), mcp,
    });
    await Promise.all(projects.map((p) => get().refreshChats(p.id)));
    applyTheme(s.settings.general.theme);
    set({ ready: true });
    let last: string | null = null;
    try { last = localStorage.getItem("lastChat"); } catch { /* storage unavailable */ }
    await get().openChat(s.settings.general.restoreLastChat && last && get().chatById[last] ? last : master.id);
  },

  setView(v) {
    set({ view: v });
  },

  async openChat(chatId) {
    const chat = get().chatById[chatId];
    set({ view: { kind: "chat", chatId }, thread: null, flowPanel: get().flowPanel?.chatId === chatId ? get().flowPanel : null, currentProjectId: chat?.projectId ?? get().currentProjectId });
    try { localStorage.setItem("lastChat", chatId); } catch { /* storage unavailable */ }
    const msgs = await api().listMessages(chatId, null);
    set((st) => ({ messages: { ...st.messages, [chatId]: msgs } }));
  },

  async openThread(chatId, rootId) {
    const msgs = await api().listMessages(chatId, rootId);
    set({ thread: { chatId, rootId, messages: msgs }, flowPanel: null });
  },

  openFlow(chatId, agentId) {
    set({ flowPanel: { chatId, agentId }, thread: null });
  },

  closeThread() {
    set({ thread: null });
  },

  async refreshProjects() {
    set({ projects: await api().listProjects() });
  },

  async refreshChats(projectId) {
    const list = await api().listChats(projectId);
    set((st) => ({ chats: { ...st.chats, [projectId]: list }, chatById: { ...st.chatById, ...Object.fromEntries(list.map((c) => [c.id, c])) } }));
  },

  upsertChat(c) {
    set((st) => {
      const key = c.projectId ?? "__none";
      const list = st.chats[key] ?? [];
      const i = list.findIndex((x) => x.id === c.id);
      const next = i < 0 ? [...list, c] : list.map((x) => (x.id === c.id ? c : x));
      return { chats: { ...st.chats, [key]: next }, chatById: { ...st.chatById, [c.id]: c } };
    });
  },

  removeChat(c) {
    set((st) => {
      const key = c.projectId ?? "__none";
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
      case "message.created": {
        const m = e.message;
        if (!st.chatById[m.chatId]) {
          // A chat created in the main process (e.g. startAgent): reload the chat lists.
          for (const p of st.projects) void st.refreshChats(p.id);
        }
        if (m.parentId === null) {
          if (st.messages[m.chatId]) set({ messages: { ...st.messages, [m.chatId]: upsertMsg(st.messages[m.chatId]!, m) } });
        } else {
          const root = m.parentId;
          set({
            messages: { ...st.messages, [m.chatId]: patchMsg(st.messages[m.chatId], root, (r) => ({ ...r, replyCount: r.replyCount + 1 })) ?? [] },
            thread: st.thread && st.thread.rootId === root ? { ...st.thread, messages: upsertMsg(st.thread.messages, m) } : st.thread,
          });
        }
        break;
      }
      case "message.delta": {
        const add = (m: Message) => ({ ...m, content: m.content + e.delta });
        set({
          messages: { ...st.messages, [e.chatId]: patchMsg(st.messages[e.chatId], e.messageId, add) ?? [] },
          thread: st.thread ? { ...st.thread, messages: patchMsg(st.thread.messages, e.messageId, add)! } : null,
        });
        break;
      }
      case "message.updated": {
        const m = e.message;
        const keep = (old: Message) => ({ ...m, replyCount: Math.max(old.replyCount, m.replyCount) });
        set({
          messages: { ...st.messages, [m.chatId]: patchMsg(st.messages[m.chatId], m.id, keep) ?? [] },
          thread: st.thread ? { ...st.thread, messages: patchMsg(st.thread.messages, m.id, keep)! } : null,
        });
        break;
      }
      case "reaction.changed": {
        const r = (m: Message) => ({ ...m, reactions: e.reactions });
        set({
          messages: { ...st.messages, [e.chatId]: patchMsg(st.messages[e.chatId], e.messageId, r) ?? [] },
          thread: st.thread ? { ...st.thread, messages: patchMsg(st.thread.messages, e.messageId, r)! } : null,
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
      case "roles.changed":
        set({ roles: e.roles });
        break;
      case "notice":
        st.toast(e.level, e.text);
        break;
    }
  },
}));

export function applyTheme(theme: "dark" | "light" | "system"): void {
  const t = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = t;
}

export function roleOf(name: string | null | undefined): RoleDef | undefined {
  return useStore.getState().roles.find((r) => r.name === name);
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
