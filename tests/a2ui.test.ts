import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  A2UI_BASIC_CATALOG, a2uiDoc, a2uiForHistory, a2uiPlainText, actionEvent, actionMessage, callFunction, childList, failedChecks, formatDate,
  getPointer, parseA2uiMessages, resolveString, setPointer, stripA2ui, stripA2uiAction,
} from "../src/shared/a2ui";
import { replyParts } from "../src/shared/replyParts";
import { A2uiBlock } from "../src/renderer/components/A2ui";
import { A2UI_RULES, extractiveSummary, buildTurnPrompt } from "../src/main/context";
import { Db } from "../src/main/db";
import { Orchestrator } from "../src/main/orchestrator";
import { HarnessRegistry } from "../src/main/harness/registry";
import { MockAdapter, MockSession, mockOverview } from "../src/main/harness/mock";
import { loadRoles } from "../src/main/roles";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../src/shared/settings";

const FIX = join(__dirname, "fixtures", "a2ui");
const examples = readdirSync(FIX).filter((f) => f.endsWith(".json")).map((f) => ({ f, ex: JSON.parse(readFileSync(join(FIX, f), "utf8")) as { messages: unknown[] } }));

const card = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: "1.0", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG,
  components: [
    { id: "root", component: "Card", child: "col" },
    { id: "col", component: "Column", children: ["title", "list", "ok"] },
    { id: "title", component: "Text", text: "### Build is green" },
    { id: "list", component: "List", children: { componentId: "item", path: "/fixes" } },
    { id: "item", component: "Text", text: { "@path": "text" } },
    { id: "ok", component: "Button", variant: "primary", child: "okt", action: { event: { name: "open_pr", userMessage: "Open the PR" } } },
    { id: "okt", component: "Text", text: "Open the PR" },
  ], dataModel: { fixes: [{ text: "paths.ts" }, { text: "build.test.ts" }] }, ...extra } });

const render = (source: string, open = false) => renderToStaticMarkup(createElement(A2uiBlock, { source, open, id: "t", chatId: "c1" }));

describe("A2UI parsing and surfaces", () => {
  it("reads a single object, JSONL, a JSON array, pretty-printed objects and the spec's {messages} examples", () => {
    const a = { version: "1.0", createSurface: { surfaceId: "a" } };
    const b = { version: "1.0", updateComponents: { surfaceId: "a", components: [{ id: "root", component: "Text", text: "hi" }] } };
    for (const src of [JSON.stringify(a), `${JSON.stringify(a)}\n${JSON.stringify(b)}`, JSON.stringify([a, b]), `${JSON.stringify(a, null, 2)}\n\n${JSON.stringify(b, null, 2)}`,
      JSON.stringify({ name: "x", messages: [a, b] })]) {
      const p = parseA2uiMessages(src);
      expect(p.errors).toEqual([]);
      expect(p.incomplete).toBe(false);
      expect(p.messages[0]).toHaveProperty("createSurface");
    }
  });

  it("a block still streaming in renders up to its last complete message", () => {
    const a = JSON.stringify({ version: "1.0", createSurface: { surfaceId: "a", components: [{ id: "root", component: "Text", text: "first" }] } });
    const p = parseA2uiMessages(`${a}\n{"version":"1.0","updateComponents":{"surfaceId":"a","comp`);
    expect(p.incomplete).toBe(true);
    expect(p.messages).toHaveLength(1);
    expect(render(`${a}\n{"version":"1.0","upd`, true)).toContain("first");
    expect(render(`{"version":"1.0","createSurf`, true)).toContain("Building the view");
  });

  it("applies updateComponents, updateDataModel (null deletes) and deleteSurface in order", () => {
    const doc = a2uiDoc([
      { version: "1.0", createSurface: { surfaceId: "a", dataModel: { user: { name: "Ann", tmp: 1 } } } },
      { version: "1.0", updateComponents: { surfaceId: "a", components: [{ id: "root", component: "Text", text: { "@path": "/user/name" } }] } },
      { version: "1.0", updateDataModel: { surfaceId: "a", path: "/user/name", value: "Bob" } },
      { version: "1.0", updateDataModel: { surfaceId: "a", path: "/user/tmp", value: null } },
      { version: "1.0", createSurface: { surfaceId: "gone" } },
      { version: "1.0", deleteSurface: { surfaceId: "gone" } },
    ].map((m) => JSON.stringify(m)).join("\n"));
    expect(doc.surfaces.map((s) => s.id)).toEqual(["a"]);
    expect(doc.surfaces[0]!.data).toEqual({ user: { name: "Bob" } });
    expect(a2uiPlainText(JSON.stringify({ version: "1.0", createSurface: { surfaceId: "a", dataModel: { n: "Ann" }, components: [{ id: "root", component: "Text", text: { "@path": "/n" } }] } }))).toBe("Ann");
  });

  it("JSON pointers: escapes, arrays, immutable set", () => {
    const d = { "a/b": { "~x": [1, 2] } };
    expect(getPointer(d, "/a~1b/~0x/1")).toBe(2);
    const e = setPointer(d, "/a~1b/~0x/0", 9) as typeof d;
    expect(e["a/b"]["~x"]).toEqual([9, 2]);
    expect(d["a/b"]["~x"]).toEqual([1, 2]);
    expect(setPointer({}, "/list/0/name", "x")).toEqual({ list: [{ name: "x" }] });
  });

  it("list templates resolve relative paths per item and @index", () => {
    const scope = { data: { items: [{ t: "a" }, { t: "b" }] }, base: "" };
    const kids = childList({ componentId: "row", path: "/items" }, scope);
    expect(kids.map((k) => resolveString({ "@path": "t" }, k.scope))).toEqual(["a", "b"]);
    expect(kids.map((k) => callFunction("@index", {}, k.scope))).toEqual([0, 1]);
  });

  it("basic catalog functions: formatting, plurals, validation and logic", () => {
    const scope = { data: { n: 3, name: "Ann", mail: "x@y.io", list: [] as string[] }, base: "" };
    expect(callFunction("formatString", { value: "Hi ${/name}, ${/n} left, \\${kept}" }, scope)).toBe("Hi Ann, 3 left, ${kept}");
    expect(callFunction("pluralize", { value: { "@path": "/n" }, one: "file", other: "files" }, scope)).toBe("files");
    expect(callFunction("pluralize", { value: 0, zero: "none", one: "one", other: "many" }, scope)).toBe("none");
    expect(callFunction("required", { value: { "@path": "/list" } }, scope)).toEqual({ valid: false });
    expect(callFunction("email", { value: { "@path": "/mail" } }, scope)).toEqual({ valid: true });
    expect(callFunction("length", { value: "abc", min: 4 }, scope)).toEqual({ valid: false });
    expect(callFunction("numeric", { value: 5, min: 1, max: 9 }, scope)).toEqual({ valid: true });
    expect(callFunction("and", { values: [true, { "@call": "not", args: { value: false } }] }, scope)).toBe(true);
    expect(callFunction("formatCurrency", { value: 12.5, currency: "EUR" }, scope)).toMatch(/12[.,]50/);
    expect(formatDate("2026-11-22T14:05:00", "EEE, MMM d yyyy HH:mm")).toBe("Sun, Nov 22 2026 14:05");
    expect(failedChecks({ id: "f", component: "TextField", "@checks": [{ condition: { "@call": "required", args: { value: { "@path": "/list" } } }, message: "Pick one" }] }, scope)).toEqual(["Pick one"]);
  });
});

describe("A2UI in the chat", () => {
  it("an ```a2ui block in a reply becomes its own part; prose around it stays Markdown", () => {
    const parts = replyParts(`Build fixed.\n\n\`\`\`a2ui\n${card()}\n\`\`\`\n\nThanks.`);
    expect(parts.map((p) => p.kind)).toEqual(["md", "a2ui", "md"]);
    expect(parts[1]).toMatchObject({ kind: "a2ui", open: false });
    // A ```json block holding A2UI messages renders too; other JSON stays a code block.
    expect(replyParts(`\`\`\`json\n${card()}\n\`\`\``)[0]!.kind).toBe("a2ui");
    expect(replyParts("```json\n{\"a\": 1}\n```")[0]!.kind).toBe("md");
    // Still streaming: no closing fence yet.
    expect(replyParts(`Working.\n\`\`\`a2ui\n${card()}`)[1]).toMatchObject({ kind: "a2ui", open: true });
  });

  it("renders cards, templates and buttons with the app's classes", () => {
    const h = render(card());
    expect(h).toContain('class="a2ui-surface"');
    expect(h).toContain("a2ui-card");
    expect(h).toContain("Build is green");
    expect(h).toContain("paths.ts");
    expect(h).toContain("build.test.ts");
    expect(h).toMatch(/class="a2ui-button primary/);
  });

  it("falls back to the source as a code block when the block isn't A2UI", () => {
    const h = render("this is not json");
    expect(h).toContain("Couldn&#x27;t show this as UI");
    expect(h).toContain("this is not json");
  });

  it("renders every official basic-catalog v1 example without errors or unsupported components", () => {
    expect(examples.length).toBeGreaterThan(40);
    for (const { f, ex } of examples) {
      const src = JSON.stringify(ex.messages);
      const doc = a2uiDoc(src);
      expect(doc.errors, f).toEqual([]);
      expect(doc.surfaces.length, f).toBeGreaterThan(0);
      expect(doc.surfaces.every((s) => s.components.root), f).toBe(true);
      const h = render(src);
      expect(h, f).toContain("a2ui-surface");
      expect(h, f).not.toContain("a2ui-unsupported");
      expect(a2uiPlainText(src).length, f).toBeGreaterThan(0);
    }
  });

  it("a button click goes back to the agent as a readable line plus the A2UI action; the chat shows only the line", () => {
    const scope = { data: { choice: ["b"] }, base: "" };
    const ev = actionEvent({ event: { name: "pick_option", context: { choice: { "@path": "/choice" }, fixed: 1 } } }, scope)!;
    expect(ev).toEqual({ name: "pick_option", userMessage: null, context: { choice: ["b"], fixed: 1 } });
    const msg = actionMessage("s1", "btn", ev, { choice: ["b"] });
    expect(msg.split("\n")[0]).toBe('Pick option: choice = ["b"], fixed = 1');
    const action = JSON.parse(/```a2ui-action\n(.*)\n/.exec(msg)![1]!);
    expect(action).toMatchObject({ version: "1.0", action: { name: "pick_option", surfaceId: "s1", sourceComponentId: "btn", context: { choice: ["b"], fixed: 1 } } });
    expect(msg).toContain('"dataModel":{"choice":["b"]}');
    expect(stripA2uiAction(msg)).toBe('Pick option: choice = ["b"], fixed = 1');
    expect(actionMessage("s1", "btn", { name: "x", userMessage: "Open the PR", context: {} }).split("\n")[0]).toBe("Open the PR");
  });

  it("history, summaries and previews carry the readable text, not the JSON", () => {
    const reply = `Build fixed.\n\n\`\`\`a2ui\n${card()}\n\`\`\``;
    const flat = stripA2ui(reply);
    expect(flat).toContain("### Build is green");
    expect(flat).toContain("paths.ts");
    expect(flat).toContain("[Open the PR]");
    expect(flat).not.toContain("createSurface");
    expect(a2uiForHistory(actionMessage("s1", "b", { name: "x", userMessage: "Open the PR", context: {} }))).toBe("Open the PR");
    expect(extractiveSummary(null, [{ author: "agent", role: "flashmaster", content: reply }])).not.toContain("createSurface");
    const prompt = buildTurnPrompt({ role: { name: "flashmaster", title: "F", description: "", prompt: "", tools: [], skills: [], maxResultTokens: 500 } as any, projectPath: "/p", skills: [], summary: null,
      recent: [{ author: "agent", role: "flashmaster", content: reply }], input: "next", firstTurn: true, clean: true, memory: "", houseRules: "" } as any);
    expect(prompt).not.toContain("createSurface");
    expect(prompt).toContain("Build is green");
  });
});

describe("the main agent replies with A2UI", () => {
  afterEach(() => vi.restoreAllMocks());
  const until = async (fn: () => boolean, ms = 8000) => {
    const t = Date.now();
    while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
  };
  async function firstPrompt(a2ui?: boolean): Promise<string> {
    const db = new Db(":memory:");
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { defaultHarness: "mock" }, agents: { toolMode: "mcp", ...(a2ui === undefined ? {} : { a2ui }) } }) as Settings;
    const roles = loadRoles(join(__dirname, "..", "agents"), "/none");
    const prompts: string[] = [];
    const orig = MockSession.prototype.prompt;
    vi.spyOn(MockSession.prototype, "prompt").mockImplementation(function (this: MockSession, text, atts) { prompts.push(text); return orig.call(this, text, atts); });
    const orch = new Orchestrator({ db, harnesses: new HarnessRegistry([new MockAdapter(1)]), settings: () => settings, roles: () => roles,
      skills: () => [], emit: () => undefined, mcpServersFor: () => [], homeDir: tmpdir(), dataDir: mkdtempSync(join(tmpdir(), "a2ui-data-")) });
    const p = db.createProject("p", mkdtempSync(join(tmpdir(), "a2ui-proj-")));
    const chat = db.createChat({ projectId: p.id, title: "c", kind: "project", agentRole: "flashmaster" });
    await orch.sendUserMessage(chat.id, "How is the build?", null);
    await until(() => db.listAgents({}).some((x) => x.status === "idle"));
    return prompts[0]!;
  }

  it("is on by default: the agent you talk to gets the A2UI rules on its first turn", async () => {
    expect(DEFAULT_SETTINGS.agents.a2ui).toBe(true);
    expect(A2UI_RULES).toContain("```a2ui");
    expect(A2UI_RULES).toContain(A2UI_BASIC_CATALOG);
    expect(await firstPrompt()).toContain(A2UI_RULES);
  });

  it("can be turned off in Settings → Agents", async () => {
    expect(await firstPrompt(false)).not.toContain(A2UI_RULES);
  });

  it("the mock's status answer (screenshots) is valid A2UI; without A2UI it is plain Markdown", () => {
    const parts = replyParts(mockOverview(true));
    expect(parts.map((p) => p.kind)).toEqual(["md", "a2ui"]);
    const src = (parts[1] as { source: string }).source;
    expect(a2uiDoc(src).errors).toEqual([]);
    expect(render(src)).toContain("Run the HIL tests");
    expect(mockOverview(false)).not.toContain("```");
  });

  it("the example in the rules is itself valid A2UI that renders", () => {
    const src = /```a2ui\n([\s\S]*?)\n```/.exec(A2UI_RULES)![1]!;
    const doc = a2uiDoc(src);
    expect(doc.errors).toEqual([]);
    expect(render(src)).toContain("Build is green");
  });
});
