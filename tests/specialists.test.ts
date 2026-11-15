import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { specialistRows } from "../src/renderer/specialists";
import type { AgentRun, RoleDef } from "../src/shared/types";

const role = (name: string) => ({ name, title: name, icon: "", description: "", tools: [], maxResultTokens: 0, skills: [], prompt: "", source: "builtin" } as RoleDef);
const agent = (id: string, r: string, status: AgentRun["status"]) => ({ id, role: r, status, chatId: `c-${id}` } as AgentRun);

describe("Specialists pill on the chat", () => {
  it("lists every role but the coordinator, with working and paused counts", () => {
    const roles = [role("flashmaster"), role("reviewer"), role("tester")];
    const agents = { a: agent("a", "reviewer", "running"), b: agent("b", "reviewer", "idle"), c: agent("c", "tester", "paused"), d: agent("d", "flashmaster", "running") };
    const { rows, working, paused } = specialistRows(roles, agents);
    expect(rows.map((r) => r.role.name)).toEqual(["reviewer", "tester"]);
    expect(rows[0]).toMatchObject({ working: 1, paused: 0 });
    expect(rows[0]?.busyAgent?.id).toBe("a");
    expect(rows[1]).toMatchObject({ working: 0, paused: 1, busyAgent: undefined });
    expect({ working, paused }).toEqual({ working: 1, paused: 1 });
  });
  it("lives in the chat, not the sidebar", () => {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
    expect(read("src/renderer/components/Sidebar.tsx")).not.toMatch(/palette-item|Specialists/);
    expect(read("src/renderer/views/ChatView.tsx")).toContain("<SpecialistsPill />");
  });
});

describe("specialist instance names", () => {
  it("picks a name not used in the chat, and numbers names once the list runs out", async () => {
    const { pickInstanceName, agentLabel, INSTANCE_NAMES } = await import("../src/shared/instances");
    expect(pickInstanceName([])).toBe(INSTANCE_NAMES[0]);
    expect(pickInstanceName([INSTANCE_NAMES[0], null])).toBe(INSTANCE_NAMES[1]);
    expect(pickInstanceName([...INSTANCE_NAMES])).toBe(`${INSTANCE_NAMES[0]} 2`);
    expect(agentLabel({ name: "Nova" }, "Coder")).toBe("Nova · Coder");
    expect(agentLabel({ name: null }, "Coder")).toBe("Coder");
  });
});
