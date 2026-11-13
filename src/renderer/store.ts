import { create } from "zustand";
import type { AgentRun, AppEvent, Chat, HarnessId, HarnessModels, McpServerStatus, Message, Project, RoleDef, SkillDef, Task, CopilotUsage, UpdateState } from "@shared/types";
import type { Settings } from "@shared/settings";

export const api = () => window.flash.api;

export type View =
  | { kind: "chat"; chatId: string }
  | { kind: "agents" }
  | { kind: "dashboard" }
  | { kind: "tasks" }
  | { kind: "jazz" }
  | { kind: "settings"; tab?: string }
  | { kind: "flow"; agentId: string }
  | { kind: "marketplace" }
  | { kind: "docs"; page?: string };

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
  artifactsPanel: string | null; // chat id whose artifacts panel is open
  artifactsRev: Record<string, number>;
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
  artifactsPanel: null,
  artifactsRev: {},
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
    set((st) => ({ models: { ...st.models, [m.harness]: m } }));
  },
  toasts: [],

  async init() {
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
    set({ view: { kind: "chat", chatId }, thread: null, flowPanel: get().flowPanel?.chatId === chatId ? get().flowPanel : null,
      artifactsPanel: get().artifactsPanel === chatId ? chatId : null, currentProjectId: chat?.projectId ?? get().currentProjectId });
    try { localStorage.setItem("lastChat", chatId); } catch { /* storage unavailable */ }
    const msgs = await api().listMessages(chatId, null);
    set((st) => ({ messages: { ...st.messages, [chatId]: mergeLoaded(msgs, st.messages[chatId]) } }));
  },

  async openThread(chatId, rootId) {
    const msgs = await api().listMessages(chatId, rootId);
    set((st) => ({ thread: { chatId, rootId, messages: mergeLoaded(msgs, st.thread?.rootId === rootId ? st.thread.messages : undefined) }, flowPanel: null, artifactsPanel: null }));
  },

  openFlow(chatId, agentId) {
    set({ flowPanel: { chatId, agentId }, thread: null, artifactsPanel: null });
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
      case "models.updated":
        st.setModels(e.models);
        break;
      case "update.state":
        set({ update: e.state });
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
      case "notice":
        st.toast(e.level, e.text);
        break;
    }
  },
}));

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

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
