import { describe, expect, it } from "vitest";
import { NO_PROJECT, pickAgentChat } from "../src/renderer/agentChat";
import { customAgents } from "../src/renderer/agentOverview";
import { chatOrder } from "../src/renderer/commands";
import type { RoleDef } from "../src/shared/types";
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
  it("starts a new chat in the current project when it has none", () => {
    expect(pickAgentChat("tester", base)).toEqual({ kind: "new", projectId: "p1" });
  });
  // Bug: with no project selected (e.g. from the master chat), agents were created in the first project in the list.
  it("never guesses the first project: without a current project the chat goes to No project", () => {
    expect(pickAgentChat("tester", { ...base, currentProjectId: null, projectIds: ["p1", "p2"] })).toEqual({ kind: "new", projectId: null });
    expect(pickAgentChat("tester", { ...base, currentProjectId: null, projectIds: [] })).toEqual({ kind: "new", projectId: null });
    expect(pickAgentChat("tester", { ...base, currentProjectId: "removed", projectIds: ["p1"] })).toEqual({ kind: "new", projectId: null });
  });
  it("reopens its latest No project chat when no project is selected", () => {
    const chats = { [NO_PROJECT]: [chat("n1", "tester", 1, { projectId: null }), chat("n2", "tester", 4, { projectId: null })], p1: [chat("c1", "tester", 9)] };
    expect(pickAgentChat("tester", { ...base, chats, currentProjectId: null })).toEqual({ kind: "open", chatId: "n2", agentId: null });
  });
});

const role = (name: string, title: string, source: RoleDef["source"] = "user"): RoleDef =>
  ({ name, title, icon: "", description: "", tools: [], maxResultTokens: 400, skills: [], prompt: "x", source });

// Bug: custom agents (imported, Marketplace, created by TheFlashMaster) were missing from the Agents overview.
describe("Agents overview lists custom agents", () => {
  const docs = ["flashmaster", "reviewer"];
  it("lists every agent without a documentation page, sorted by title", () => {
    const roles = [role("flashmaster", "TheFlashMaster", "builtin"), role("zeta", "Zeta Checker"), role("can-log", "CAN Log Analyst"), role("reviewer", "Code Reviewer", "builtin")];
    expect(customAgents(roles, docs).map((r) => r.name)).toEqual(["can-log", "zeta"]);
  });
  it("keeps a user file that overrides a built-in on the built-in's page, and lists undocumented built-ins", () => {
    const roles = [role("reviewer", "My Reviewer"), role("new-builtin", "New Built-in", "builtin")];
    expect(customAgents(roles, docs).map((r) => r.name)).toEqual(["new-builtin"]);
  });
});

describe("No project section", () => {
  it("comes after the projects in sidebar order", () => {
    const chats = { p1: [chat("a", "flashmaster", 1)], [NO_PROJECT]: [chat("n", "tester", 2, { projectId: null })] };
    expect(chatOrder("m", ["p1"], chats)).toEqual(["m", "a", "n"]);
  });
});
