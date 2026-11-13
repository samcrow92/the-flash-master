import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter, pickOption, promptBlocks } from "../src/main/harness/acp";
import { PiSession } from "../src/main/harness/pi";
import { MockAdapter } from "../src/main/harness/mock";
import { HarnessRegistry } from "../src/main/harness/registry";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { loadRoles, loadSkills } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { AppEvent, Attachment } from "../src/shared/types";
import type { HarnessEvent, SessionOptions } from "../src/main/harness/types";

const FAKE = join(__dirname, "fixtures", "fake-acp-agent.mjs");
const FAKE_PI = join(__dirname, "fixtures", "fake-pi.mjs");
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};
const dir = mkdtempSync(join(tmpdir(), "att-"));
const img = join(dir, "shot.png");
writeFileSync(img, Buffer.from("89504e470d0a1a0a", "hex"));
const txt = join(dir, "notes.txt");
writeFileSync(txt, "hello");
const ATT: Attachment[] = [
  { id: "a1", name: "shot.png", mime: "image/png", size: 8, kind: "image", path: img },
  { id: "a2", name: "notes.txt", mime: "text/plain", size: 5, kind: "file", path: txt },
];

function setup(over: DeepPartial<Settings> = {}) {
  const db = new Db(":memory:");
  let settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, ...over } as any) as Settings;
  const harnesses = new HarnessRegistry([new MockAdapter(2), new AcpAdapter("opencode", "Fake ACP", [process.execPath], [FAKE], "")]);
  (harnesses as any).status.set("opencode", { id: "opencode", available: true, path: process.execPath });
  const events: AppEvent[] = [];
  const orch = new Orchestrator({ db, harnesses, settings: () => settings, roles: () => loadRoles(join(__dirname, "..", "agents"), "/none"),
    skills: () => loadSkills(join(__dirname, "..", "skills", "superpowers")), emit: (e) => events.push(e), mcpServersFor: () => [], homeDir: tmpdir() });
  const p = db.createProject("p", mkdtempSync(join(tmpdir(), "proj-")));
  const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
  return { db, orch, events, chat, set: (x: DeepPartial<Settings>) => { settings = mergeSettings(settings, x); } };
}
const agentMsgs = (db: Db, chatId: string) => db.listMessages(chatId, null).filter((m) => m.author === "agent");

describe("attachments", () => {
  it("sends images inline and files as resource links (with a plain-text fallback)", () => {
    const blocks = promptBlocks("look", ATT.map(({ kind, name, mime, path }) => ({ kind, name, mime, path })), { image: true });
    expect(blocks.map((b) => b.type)).toEqual(["text", "image", "resource_link"]);
    expect(blocks[1]!).toMatchObject({ mimeType: "image/png", data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") });
    expect(blocks[2]!.uri).toMatch(/^file:\/\//);
    expect(blocks[0]!.text).toContain("notes.txt");
    const noImg = promptBlocks("look", [{ kind: "image", name: "shot.png", mime: "image/png", path: img }], { image: false });
    expect(noImg.map((b) => b.type)).toEqual(["text", "resource_link"]);
  });

  it("stores attachments on the user message and passes them to the harness", async () => {
    const { db, orch, chat } = setup();
    db.updateChat(chat.id, { harness: "opencode" });
    await orch.sendUserMessage(chat.id, "what is in these?", null, { attachments: ATT });
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    expect(db.listMessages(chat.id, null)[0]!.attachments.map((a) => a.name)).toEqual(["shot.png", "notes.txt"]);
    expect(agentMsgs(db, chat.id)[0]!.content).toContain("blocks=text,image,resource_link");
    await orch.stopAll();
  });
});

describe("steering", () => {
  it("Pi steers natively inside the running turn", async () => {
    const events: HarnessEvent[] = [];
    const o = { cwd: process.cwd(), model: null, extraArgs: "", executable: null, mcpServers: [], env: {}, resumeSessionId: null,
      policy: { approval: "auto-all", readOnly: false, blocked: [], projectRoot: null }, onEvent: (e: HarnessEvent) => events.push(e), askPermission: async () => true } as SessionOptions;
    const s = new PiSession(process.execPath, [FAKE_PI, "--mode", "rpc", "--thinking", "medium"], o);
    await s.init();
    const p = s.prompt("SLOW", [{ kind: "image", name: "a.png", mime: "image/png", path: img }]);
    await new Promise((r) => setTimeout(r, 120));
    expect(await s.steer("use the CAN log instead")).toBe(true);
    await p;
    const text = events.map((e: any) => e.text ?? "").join("");
    expect(text).toContain("[steered: use the CAN log instead]");
    expect(text).toContain("(thinking=medium)");
    expect(text).toContain("(images=1)");
    s.close();
  });

  it("other harnesses are interrupted and redirected; queue mode waits for the turn", async () => {
    const { db, orch, chat, events } = setup();
    db.updateChat(chat.id, { harness: "opencode" });
    await orch.sendUserMessage(chat.id, "SLOW long analysis", null);
    await until(() => events.some((e) => e.type === "message.delta"));
    await orch.sendUserMessage(chat.id, "focus on the brake ECU only", null, { whileBusy: "steer" });
    await until(() => agentMsgs(db, chat.id).length === 2 && agentMsgs(db, chat.id)[1]!.status === "done");
    const [first, second] = agentMsgs(db, chat.id);
    expect(first!.content).toContain("Redirected by your steering message");
    expect(db.listMessages(chat.id, null).find((m) => m.content === "focus on the brake ECU only")!.steer).toBe(true);
    expect(second!.status).toBe("done");
    // queue: no redirect, message answered after the running turn
    await orch.sendUserMessage(chat.id, "SLOW again", null);
    await until(() => db.listMessages(chat.id, null).filter((m) => m.author === "agent" && m.status === "streaming").length === 1);
    await orch.sendUserMessage(chat.id, "and then summarise", null, { whileBusy: "queue" });
    await until(() => agentMsgs(db, chat.id).length === 4 && agentMsgs(db, chat.id)[3]!.status === "done");
    expect(agentMsgs(db, chat.id)[2]!.content).not.toContain("Redirected");
    await orch.stopAll();
  }, 20000);
});

describe("autopilot and drive modes", () => {
  it("autopilot auto-approves tool calls and tells the agent not to ask", async () => {
    const { db, orch, chat } = setup({ permissions: { approval: "ask" } });
    db.updateChat(chat.id, { harness: "opencode", autopilot: true });
    await orch.sendUserMessage(chat.id, "WRITE the fix", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    expect(agentMsgs(db, chat.id)[0]!.content).toContain("permission=ok");
    expect(db.listMessages(chat.id, null).some((m) => m.content.includes("React ✅"))).toBe(false);
    const agent = db.listAgents({})[0]!;
    expect(db.listEvents(agent.id).some((e) => e.kind === "approval" && /autopilot/.test(e.status ?? ""))).toBe(true);
    await orch.stopAll();
  });

  it("a drive mode sets harness, model and thinking level for the chat", async () => {
    const { db, orch, chat } = setup({ modes: { comfort: { harness: "opencode", model: "claude-sonnet-4.5", thinking: "low" } } });
    db.updateChat(chat.id, { mode: "comfort" });
    await orch.sendUserMessage(chat.id, "which model", null);
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    expect(agentMsgs(db, chat.id)[0]!.content).toContain("model=claude-sonnet-4.5 thinking=low");
    expect(db.listAgents({})[0]!.harness).toBe("opencode");
    // switching mode restarts idle sessions with the new profile
    db.updateChat(chat.id, { mode: "sport" });
    orch.resetChatSessions(chat.id);
    expect(db.listAgents({ activeOnly: true })).toHaveLength(0);
    await orch.stopAll();
  });

  it("matches thinking levels to the harness's option values", () => {
    const opt = { options: [{ value: "effort-low", name: "Low" }, { value: "effort-high", name: "High" }] };
    expect(pickOption(opt, "high")).toBe("effort-high");
    expect(pickOption(opt, "Low")).toBe("effort-low");
    expect(pickOption(opt, "xhigh")).toBeNull();
  });
});

describe("chat management", () => {
  it("archives, pins and renames chats persistently", () => {
    const { db, chat } = setup();
    db.updateChat(chat.id, { pinned: true, title: "Brake ECU review" });
    expect(db.getChat(chat.id)).toMatchObject({ pinned: true, archived: false, title: "Brake ECU review" });
    db.updateChat(chat.id, { archived: true, pinned: false });
    expect(db.listChats(chat.projectId)[0]).toMatchObject({ archived: true, pinned: false });
  });

  it("reset context closes the chat's sessions, adds a divider and sends no earlier history", async () => {
    const { db, orch, chat, events } = setup();
    await orch.sendUserMessage(chat.id, "first topic", null, {});
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    expect([...(orch as any).live.values()].some((l: any) => l.chatId === chat.id)).toBe(true);
    const marker = orch.resetContext(chat.id);
    expect(marker).toMatchObject({ author: "system", marker: "context-reset" });
    expect(events.some((e) => e.type === "message.created" && e.message.id === marker.id)).toBe(true);
    expect([...(orch as any).live.values()].some((l: any) => l.chatId === chat.id)).toBe(false);
    expect(db.getChatSummary(chat.id).upto).toBe(marker.seq);
    // the next session's history starts after the boundary
    expect(db.history(chat.id, null, db.getChatSummary(chat.id).upto).map((m) => m.content)).toEqual([]);
    expect(db.listMessages(chat.id, null).find((m) => m.id === marker.id)?.marker).toBe("context-reset");
    await orch.stopAll();
  });

  it("refuses to reset while an agent is working", async () => {
    const { orch, chat } = setup();
    void orch.sendUserMessage(chat.id, "work", null, {});
    await until(() => [...(orch as any).live.values()].some((l: any) => l.busy));
    expect(() => orch.resetContext(chat.id)).toThrow(/stop it first/);
    await orch.stopAll();
  });
});

describe("files changed by agents", () => {
  it("records ACP diff content once and writes through the client with before/after", async () => {
    const { db, orch, chat, events } = setup({ permissions: { approval: "auto-all" } } as any);
    db.updateChat(chat.id, { harness: "opencode" });
    const proj = db.getProject(chat.projectId!)!.path;
    const f = join(proj, "notes.txt");
    writeFileSync(f, "hello v1\n");
    await orch.sendUserMessage(chat.id, `EDITDIFF and WRITEFILE:${f}`, null, {});
    await until(() => agentMsgs(db, chat.id)[0]?.status === "done");
    const changes = db.listFileChanges(chat.id);
    expect(changes.map((c) => c.path).sort()).toEqual(["/proj/src/a.c", "notes.txt"]);
    const a = changes.find((c) => c.path === "/proj/src/a.c")!;
    expect(a).toMatchObject({ added: 2, removed: 1, isNew: false });
    const n = db.getFileChange(changes.find((c) => c.path === "notes.txt")!.id)!;
    expect(n).toMatchObject({ oldText: "hello v1\n", newText: "hello v2\n" });
    expect(events.some((e) => e.type === "artifacts.changed" && e.chatId === chat.id)).toBe(true);
    await orch.stopAll();
  });
});
