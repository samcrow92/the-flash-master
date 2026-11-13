import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/main/db";
import {
  budgetState, buildBrief, buildTurnPrompt, clipOutput, estimateTokens, extractiveSummary, parseMention, parseResult, parseSlash,
  planCompaction, resultForParent, rolePrefix,
} from "../src/main/context";
import { decidePermission, insideRoot } from "../src/main/harness/policy";
import { SettingsStore } from "../src/main/settings-store";
import { loadRoles, loadSkills, parseFrontmatter } from "../src/main/roles";
import { parseWorkItems, JazzClient, type FetchLike } from "../src/main/jazz";
import { splitArgs } from "../src/main/harness/process";
import type { RoleDef } from "../src/shared/types";

const tmp = () => mkdtempSync(join(tmpdir(), "flash-"));
const role: RoleDef = { name: "reviewer", title: "Code Reviewer", icon: "🔍", description: "", tools: [], maxResultTokens: 50, skills: [], prompt: "Review.", source: "builtin" };

describe("Db", () => {
  it("stores projects, chats, threads, reactions, tasks and usage", () => {
    const db = new Db(":memory:");
    const p = db.createProject("demo", "/tmp/demo");
    expect(db.createProject("again", "/tmp/demo").id).toBe(p.id); // path is unique
    const c = db.createChat({ projectId: p.id, title: "General", kind: "project", agentRole: "flashmaster" });
    const root = db.addMessage({ chatId: c.id, author: "user", content: "hi" });
    db.addMessage({ chatId: c.id, parentId: root.id, author: "agent", content: "reply", role: "reviewer" });
    expect(db.listMessages(c.id, null).map((m) => m.replyCount)).toEqual([1]);
    expect(db.listMessages(c.id, root.id)).toHaveLength(2);
    expect(db.toggleReaction(root.id, "👍")).toEqual(["👍"]);
    expect(db.toggleReaction(root.id, "👍")).toEqual([]);
    const a = db.createAgent({ projectId: p.id, chatId: c.id, role: "reviewer", harness: "mock", model: null, brief: "b" });
    db.recordUsage({ agentId: a.id, projectId: p.id, harness: "mock", role: "reviewer", tokensIn: 100, tokensOut: 50, estimated: false });
    expect(db.getAgent(a.id)).toMatchObject({ tokensIn: 100, tokensOut: 50, estimated: false });
    const u = db.usageSummary(7, 1000);
    expect(u.totals.tokensIn).toBe(100);
    expect(u.byProject[0]).toMatchObject({ label: "demo", tokens: 150 });
    expect(u.budget.usedToday).toBe(150);
    const t = db.createTask({ title: "Fix", projectId: p.id });
    expect(db.updateTask(t.id, { status: "done" }).status).toBe("done");
    expect(db.listTasks({ projectId: p.id, status: "done" })).toHaveLength(1);
    expect(db.getOrCreateMasterChat().id).toBe(db.getOrCreateMasterChat().id);
    const working = db.createAgent({ projectId: p.id, chatId: c.id, role: "tester", harness: "mock", model: null, brief: "run the suite" });
    db.updateAgent(working.id, { status: "running" });
    expect(db.interruptOrphans().map((x) => x.id)).toEqual([working.id]);
    expect(db.getAgent(a.id)!.status).toBe("stopped"); // idle: only waiting for input
    expect(db.getAgent(working.id)).toMatchObject({ status: "interrupted", brief: "run the suite" });
    expect(db.listInterrupted().map((x) => x.id)).toEqual([working.id]);
  });

  it("migrates a file database idempotently", () => {
    const f = join(tmp(), "x.db");
    new Db(f).close();
    const db = new Db(f);
    expect(db.listProjects()).toEqual([]);
    db.close();
  });
});

describe("token efficiency engine", () => {
  it("clips large output into an artifact reference", () => {
    let stored = "";
    const r = clipOutput("x".repeat(10000), 1000, (full) => { stored = full; return "abc123"; });
    expect(r.clipped).toBe(true);
    expect(stored).toHaveLength(10000);
    expect(r.text.length).toBeLessThan(1200);
    expect(r.text).toContain('fetch_artifact("abc123")');
    expect(clipOutput("short", 1000, () => "x").clipped).toBe(false);
  });

  it("parses mentions and slash commands", () => {
    expect(parseMention("@reviewer check this", ["reviewer"])).toEqual({ role: "reviewer", text: "check this" });
    expect(parseMention("@nobody hi", ["reviewer"]).role).toBeNull();
    expect(parseSlash("/tdd write tests")).toEqual({ command: "tdd", text: "write tests" });
    expect(parseSlash("no command").command).toBeNull();
  });

  it("keeps the role prefix byte-stable and sends only new input after the first turn", () => {
    expect(rolePrefix(role, "/p")).toBe(rolePrefix(role, "/p"));
    const first = buildTurnPrompt({ role, projectPath: "/p", skills: [], summary: "earlier stuff", recent: [{ author: "user", role: null, content: "q1" }], input: "q2", firstTurn: true });
    expect(first).toContain("# Role: Code Reviewer");
    expect(first).toContain("earlier stuff");
    expect(first).toContain("## Request\nq2");
    const next = buildTurnPrompt({ role, projectPath: "/p", skills: [], summary: null, recent: [], input: "q3", firstTurn: false });
    expect(next).toBe("q3");
  });

  it("plans compaction and summarises deterministically", () => {
    const hist = Array.from({ length: 10 }, (_, i) => ({ author: (i % 2 ? "agent" : "user") as "user" | "agent", role: "x", content: "word ".repeat(400) }));
    const plan = planCompaction(hist, 1000, 4);
    expect(plan.compact).toBe(true);
    expect(plan.keep).toHaveLength(4);
    expect(plan.summarise).toHaveLength(6);
    expect(planCompaction(hist.slice(0, 2), 100000, 4).compact).toBe(false);
    const s = extractiveSummary(null, [{ author: "agent", role: "reviewer", content: "blah\n<result>\nsummary: found 2 bugs\n</result>" }]);
    expect(s).toBe("- reviewer: found 2 bugs");
  });

  it("parses result blocks and caps what goes back to the parent", () => {
    const text = "work...\n<result>\nsummary: All good\nfindings:\n- a.c:3 leak\n- b.c:9 race\nartifacts: a1b2, c3d4\n</result>";
    expect(parseResult(text)).toEqual({ summary: "All good", findings: ["a.c:3 leak", "b.c:9 race"], artifacts: ["a1b2", "c3d4"] });
    expect(resultForParent(text, 400)).toContain("findings:\n- a.c:3 leak");
    expect(resultForParent("z".repeat(5000), 10).length).toBeLessThan(100);
  });

  it("builds briefs and budget states", () => {
    expect(buildBrief({ goal: "Fix X", files: ["a.c"], acceptance: "tests pass", parentRole: "flashmaster" })).toContain("Relevant files: a.c");
    expect(budgetState(50, 0, 80)).toBe("ok");
    expect(budgetState(85, 100, 80)).toBe("warn");
    expect(budgetState(100, 100, 80)).toBe("exceeded");
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("permission policy", () => {
  const base = { approval: "auto-read" as const, readOnly: false, blocked: ["rm -rf /"], projectRoot: "/p" };
  it("decides per kind, read-only and blocklist", () => {
    expect(decidePermission(base, "read", "cat a")).toBe("allow");
    expect(decidePermission(base, "edit", "edit a")).toBe("ask");
    expect(decidePermission({ ...base, approval: "auto-all" }, "execute", "make")).toBe("allow");
    expect(decidePermission({ ...base, readOnly: true, approval: "auto-all" }, "edit", "x")).toBe("deny");
    expect(decidePermission({ ...base, approval: "auto-all" }, "execute", "sudo RM -RF / now")).toBe("deny");
  });
  it("confines paths to the project root", () => {
    expect(insideRoot("/p", "/p/src/a.c")).toBe(true);
    expect(insideRoot("/p", "src/a.c")).toBe(true);
    expect(insideRoot("/p", "/p/../etc/passwd")).toBe(false);
    expect(insideRoot(null, "/p/a")).toBe(false);
  });
});

describe("settings store", () => {
  it("merges defaults, user values and locked enterprise policy", () => {
    const d = tmp();
    const policy = join(d, "policy.json");
    writeFileSync(policy, JSON.stringify({ settings: { network: { proxy: "http://corp:8080" } }, lock: ["network"] }));
    const s = new SettingsStore(join(d, "settings.json"), policy);
    expect(s.get().network.proxy).toBe("http://corp:8080");
    expect(s.get().tokens.clipOutputChars).toBe(6000);
    s.update({ network: { proxy: "http://evil" }, tokens: { dailyBudget: 5 } });
    expect(s.get().network.proxy).toBe("http://corp:8080");
    expect(s.get().tokens.dailyBudget).toBe(5);
    expect(s.locked()).toContain("network.proxy");
    expect(new SettingsStore(join(d, "settings.json"), null).get().tokens.dailyBudget).toBe(5); // persisted
  });
});

describe("roles and skills", () => {
  it("loads the shipped specialists and on-demand skills", () => {
    const roles = loadRoles(join(__dirname, "..", "agents"), join(tmp(), "none"));
    const names = roles.map((r) => r.name);
    expect(names[0]).toBe("flashmaster");
    for (const n of ["reviewer", "architect", "analyst", "software-expert", "tester", "autosar-vector", "winidea-debugger", "jazz-analyst", "presentation-expert", "rca-analyst", "challenger", "exam-test-agent"]) expect(names).toContain(n);
    expect(roles.find((r) => r.name === "exam-test-agent")!.tools).toContain("exam");
    expect(roles.find((r) => r.name === "autosar-vector")!.tools).toContain("vector-autosar");
    const skills = loadSkills(join(__dirname, "..", "skills", "superpowers"));
    expect(skills.map((s) => s.command).sort()).toEqual(["brainstorm", "debug", "execute", "plan", "review", "superpowers-index", "tdd", "verify"]);
  });
  it("user roles override built-ins", () => {
    const dir = tmp();
    writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\ntitle: Strict Reviewer\ntools: [flashmaster-core]\n---\nBe strict.");
    const r = loadRoles(join(__dirname, "..", "agents"), dir).find((x) => x.name === "reviewer")!;
    expect(r).toMatchObject({ title: "Strict Reviewer", source: "user", prompt: "Be strict." });
    expect(parseFrontmatter("no frontmatter").body).toBe("no frontmatter");
  });
});

describe("misc", () => {
  it("splits CLI args with quotes", () => {
    expect(splitArgs(`--a "b c" 'd e' f`)).toEqual(["--a", "b c", "d e", "f"]);
  });
});

describe("Jazz client", () => {
  const xml = `<workitem><workItem><id>123</id><summary>Brake light &amp; flicker</summary><description>&lt;b&gt;Lamp&lt;/b&gt; flickers</description>
    <state><name>New</name></state><type><name>Defect</name></type><owner><name>Mari</name></owner></workItem></workitem>`;
  it("parses reportable REST XML", () => {
    expect(parseWorkItems(xml, "https://j/ccm")).toEqual([{ id: "123", title: "Brake light & flicker", description: "Lamp flickers", state: "New",
      type: "Defect", owner: "Mari", url: "https://j/ccm/resource/itemName/com.ibm.team.workitem.WorkItem/123" }]);
  });
  it("never asks for manual redirects (Electron cancels them) and detects login success/failure from auth headers", async () => {
    // Behaves like Electron session.fetch + an EWM server: redirect:"manual" throws, redirects are followed transparently.
    const server = (password: string): FetchLike => {
      let session = false;
      return async (url, init: any) => {
        if (init?.redirect === "manual") throw new Error("net::ERR_ABORTED: Redirect was cancelled");
        const h = new Map<string, string>();
        let finalUrl = url;
        if (url.endsWith("/authenticated/identity") && !session) { h.set("x-com-ibm-team-repository-web-auth-msg", "authrequired"); finalUrl = "https://j/ccm/auth/authrequired"; }
        if (url.endsWith("/j_security_check")) {
          if (init.body.includes(`j_password=${password}`)) session = true;
          else { h.set("x-com-ibm-team-repository-web-auth-msg", "authfailed"); finalUrl = "https://j/ccm/auth/authfailed"; }
        }
        return { status: 200, ok: true, url: finalUrl, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: async () => xml };
      };
    };
    const cfg = { serverUrl: "https://j/ccm", projectAreas: [], authType: "form" as const, username: "u", password: "right" };
    expect(await new JazzClient(cfg, server("right")).test()).toMatchObject({ ok: true, detail: expect.stringMatching(/^Connected as u · search works/) });
    const bad = await new JazzClient(cfg, server("other")).test();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/login failed/);
  });

  it("logs in with form auth, keeps cookies and queries", async () => {
    const calls: { url: string; init: any }[] = [];
    let loggedIn = false;
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const headers = new Map<string, string>();
      if (url.endsWith("/j_security_check")) { headers.set("set-cookie", "JSESSIONID=abc; Path=/"); loggedIn = true; }
      if (url.endsWith("/authenticated/identity") && !loggedIn) headers.set("x-com-ibm-team-repository-web-auth-msg", "authrequired");
      return { status: 200, ok: true, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => xml };
    };
    const j = new JazzClient({ serverUrl: "https://j/ccm/", projectAreas: ["Body"], authType: "form", username: "u", password: "p" }, fetch);
    const items = await j.query("state/group='open'");
    expect(items[0]!.id).toBe("123");
    expect(calls[1]!.url).toBe("https://j/ccm/j_security_check");
    expect(calls[1]!.init.body).toBe("j_username=u&j_password=p");
    expect(calls[2]!.url).toBe("https://j/ccm/authenticated/identity"); // confirms the login took
    expect(decodeURIComponent(calls[3]!.url)).toContain("[(projectArea/name='Body') and (state/group='open')]");
    expect(calls[3]!.init.headers.Cookie).toBe("JSESSIONID=abc");
    expect((await j.query("flicker")).length).toBe(1);
    expect((await j.query("nothing-matches")).length).toBe(0);
  });
});
