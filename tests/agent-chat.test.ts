import { describe, expect, it } from "vitest";
import { pickAgentChat } from "../src/renderer/agentChat";
import type { AgentRun, Chat } from "../src/shared/types";

const chat = (id: string, agentRole: string, createdAt: number, extra: Partial<Chat> = {}): Chat => ({
  id, projectId: "p1", title: id, kind: "project", agentRole, harness: null, model: null, superpowers: false, mode: null,
  autopilot: false, archived: false, pinned: false, createdAt, ...extra,
});
const agent = (id: string, role: string, status: AgentRun["status"], chatId: string | null, startedAt = 1) =>
  ({ id, role, status, chatId, startedAt, projectId: "p1" } as AgentRun);
const base = { agents: {}, chats: {}, projectIds: ["p1"], currentProjectId: "p1", masterChatId: "m" };

describe("open an agent's chat from the Agents section", () => {
  it("TheFlashMaster opens the master chat", () => {
    expect(pickAgentChat("flashmaster", base)).toEqual({ kind: "open", chatId: "m", agentId: null });
  });
  it("a working agent opens the chat it works in, with its progress", () => {
    const agents = { a1: agent("a1", "reviewer", "idle", "old"), a2: agent("a2", "reviewer", "running", "c9", 5) };
    expect(pickAgentChat("reviewer", { ...base, agents })).toEqual({ kind: "open", chatId: "c9", agentId: "a2" });
  });
  it("otherwise opens its latest non-archived chat in the current project", () => {
    const chats = { p1: [chat("c1", "tester", 1), chat("c2", "tester", 3), chat("c3", "tester", 9, { archived: true }), chat("c4", "reviewer", 10)] };
    expect(pickAgentChat("tester", { ...base, chats })).toEqual({ kind: "open", chatId: "c2", agentId: null });
  });
  it("starts a new chat when it has none, and asks for a project when there is none", () => {
    expect(pickAgentChat("tester", base)).toEqual({ kind: "new", projectId: "p1" });
    expect(pickAgentChat("tester", { ...base, currentProjectId: null })).toEqual({ kind: "new", projectId: "p1" });
    expect(pickAgentChat("tester", { ...base, currentProjectId: null, projectIds: [] })).toEqual({ kind: "no-project" });
  });
});
