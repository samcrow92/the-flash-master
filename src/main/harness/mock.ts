/**
 * Offline mock harness — lets the whole app (streaming, threads, pause/stop, dashboard) be tried and tested
 * without any agent CLI installed. Replies are deterministic and include a result block.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { renderDiagram } from "@shared/diagrams";
import { pathToFileURL } from "node:url";
import type { HarnessStatus } from "@shared/types";
import { estimateTokens } from "../context";
import type { HarnessAdapter, HarnessSession, PromptAttachment, SessionOptions, TurnResult } from "./types";

export class MockSession implements HarnessSession {
  readonly sessionId = `mock-${randomUUID().slice(0, 8)}`;
  private cancelled = false;
  private closed = false;
  private turn = 0;
  /** "[silent-always]": every reply of this session is empty, to try (and test) recovery and the "needs you" card. */
  private silent = false;
  /** The session was told to reply with A2UI (the main agent): button clicks get an A2UI answer too. */
  private a2ui = false;

  constructor(private o: SessionOptions, private delayMs: number) {}

  get alive(): boolean {
    return !this.closed;
  }

  private writeReport(): string | null {
    if (!this.o.cwd) return null;
    try {
      const dir = join(this.o.cwd, "reports");
      mkdirSync(dir, { recursive: true });
      const svg = renderDiagram("ishikawa", { problem: "Brake light flickers at cold start (-20 °C)", categories: {
        Requirements: ["No cold-start timing requirement (confirmed)"], "Design / Architecture": ["Shared PWM timer (confirmed)"],
        "Verification & Validation": ["No test below -10 °C (confirmed)"] } });
      const file = join(dir, "rca-report.html");
      // Styled, with a small inline script (the causes table is built by it), like real agent reports: shows that the in-app
      // report viewer runs report scripts offline.
      writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><title>RCA (mock)</title><style>`
        + `body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1d2433;background:#f6f7fb}header{background:linear-gradient(120deg,#2a3a8f,#5b3fd1);color:#fff;padding:22px 32px}`
        + `header h1{margin:0;font-size:22px}header p{margin:4px 0 0;opacity:.8}main{padding:8px 32px 32px;max-width:1000px}h2{font-size:16px;margin:22px 0 8px}`
        + `figure{margin:0;background:#fff;border:1px solid #e3e6ef;border-radius:12px;padding:12px;overflow:auto}figure svg{max-width:100%;height:auto}`
        + `table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden}td,th{padding:8px 12px;border-bottom:1px solid #eceef4;text-align:left}`
        + `th{background:#eef0f8;font-weight:600}.ok{color:#1d8a4e;font-weight:600}</style></head>`
        + `<body><header><h1>Root-cause analysis (mock)</h1><p>Brake light flicker at cold start · Ishikawa + INCOSE</p></header><main>`
        + `<h2>Ishikawa</h2><figure>${svg}</figure><h2>Confirmed causes</h2><table id="causes"><tr><th>Category</th><th>Cause</th><th>Status</th></tr></table>`
        + `<script>for(const [c,w] of [["Requirements","No cold-start timing requirement"],["Design / Architecture","Shared PWM timer"],["Verification & Validation","No test below -10 °C"]])`
        + `document.getElementById("causes").insertAdjacentHTML("beforeend","<tr><td>"+c+"</td><td>"+w+"</td><td class=ok>confirmed</td></tr>")</script>`
        + `</main></body></html>`);
      return file;
    } catch { return null; }
  }

  /** "screenshot" in a request: a small PNG "capture" in <project>/reports, to show images in chats offline. */
  private writeScreenshot(): string | null {
    if (!this.o.cwd) return null;
    try {
      const dir = join(this.o.cwd, "reports");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "cold-start-dashboard.png");
      writeFileSync(file, mockPng(480, 270));
      return file;
    } catch { return null; }
  }

  async prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult> {
    this.cancelled = false;
    this.turn += 1;
    const request = /## Request\n([\s\S]*)$/.exec(text)?.[1] ?? text;
    const role = /# Role: (.+)/.exec(text)?.[1] ?? "Mock agent";
    // "html report" in a request, or being sent back by the app's deliverable check, makes the mock write a small report
    // with an Ishikawa and link it, as real agents are told to (shows the enforcement loop offline).
    const report = /\bhtml report\b/i.test(request) || /TheFlashMaster checked your result/.test(text) ? this.writeReport() : null;
    const screenshot = /\bscreenshot\b/i.test(request) ? this.writeScreenshot() : null;
    // "status overview" to the main agent: the same answer as A2UI rich UI (when it was given the A2UI rules) or as Markdown.
    if (text.includes("## Replies as A2UI")) this.a2ui = true;
    const clicked = this.a2ui ? /```a2ui-action\n(.*)/.exec(request)?.[1] : undefined;
    const overview = /\bstatus overview\b/i.test(request) ? mockOverview(this.a2ui) : clicked ? mockActionAck(clicked) : null;
    const reply = overview ?? [
      `**${role}** (mock harness, turn ${this.turn}) received:`,
      `> ${request.trim().split("\n")[0]!.slice(0, 160)}`,
      ...(attachments?.length ? ["", `Attachments received: ${attachments.map((a) => `${a.name} (${a.kind})`).join(", ")}`] : []),
      ...(/Autopilot/.test(text) ? ["", "_Autopilot is on — continuing without asking for confirmation._"] : []),
      "",
      "This is a simulated streaming reply so you can try TheFlashMaster without an agent CLI. Enable Copilot, OpenCode, Pi or GitLab Duo in **Settings → Harnesses** for real work.",
      "",
      ...(text.includes("```ishikawa") ? [
        "Example root-cause view (mock):", "",
        "```ishikawa",
        JSON.stringify({ problem: "Brake light flickers at cold start (-20 °C)", categories: {
          "Requirements": ["No debounce requirement (confirmed)", "Timing spec ambiguous"], "Design / Architecture": ["Shared PWM timer (confirmed)"],
          "Implementation": ["Filter off-by-one (ruled out)"], "Verification & Validation": ["HIL misses cold start (confirmed)"],
          "Process": ["Late change without impact analysis"], "Tools & Environment": ["Cold chamber unavailable"] } }),
        "```", ""] : []),
      ...(report ? ["Report written: [rca-report.html](" + pathToFileURL(report).href + ")", "",
        "Background: [ISO 26262 overview](https://www.iso.org/standard/68383.html). The file is also at `reports/rca-report.html`.", ""] : []),
      ...(screenshot ? ["Captured the cold-start dashboard:", "", `![Cold-start dashboard](${pathToFileURL(screenshot).href})`, ""] : []),
      ...(/\b(fix|implement|change|edit|debounce)\b/i.test(request) ? [
        "Proposed change (mock) — also shown in **Artifacts → Changes**:", "",
        "```c", "// file: brake_light.c", ...MOCK_NEW.trimEnd().split("\n"), "```", ""] : []),
      "<result>",
      // "[needs-decision]" in a request makes the mock ask back, to try (and test) decision routing.
      // "[blocked-local]": a specialist refusing hosted inference (locality routing tests).
      ...(request.includes("[blocked-local]") ? ["status: blocked", "question: The brief requires verified local inference before any repository read; this session runs on a hosted model."] : []),
      ...(request.includes("[needs-decision]") ? ["status: needs_decision", "question: Use calibration set A or B? I recommend A (mock).", "options: Set A | Set B"] : []),
      `summary: Mock run for "${request.trim().slice(0, 60)}" completed.`,
      "findings:",
      "- No real analysis was performed (mock harness).",
      "artifacts: none",
      "</result>",
    ].join("\n");
    const steps = ["Understand the request", "Inspect relevant files", "Draft the answer", "Write the result block"];
    const plan = (done: number) => steps.map((title, i) => ({ title, status: (i < done ? "completed" : i === done ? "in_progress" : "pending") as "completed" | "in_progress" | "pending" }));
    this.o.onEvent({ type: "plan", entries: plan(0) });
    for (const w of "The request needs the project layout first, then the signals involved. I'll list the sources before answering.".split(/(?<=\s)/)) {
      this.o.onEvent({ type: "thought", text: w });
    }
    this.o.onEvent({ type: "tool", id: `ls-${this.turn}`, title: "Reading project structure", status: "in_progress", kind: "execute", input: "git ls-files src | head -20" });
    this.o.onEvent({ type: "tool", id: `ls-${this.turn}`, title: "Reading project structure", status: "completed", kind: "execute",
      output: "src/brake_light.c\nsrc/brake_light.h\nsrc/can_signals.c\nsrc/can_signals.h\ntests/test_brake_light.c" });
    if (screenshot) {
      this.o.onEvent({ type: "tool", id: `shot-${this.turn}`, title: "Taking a screenshot", status: "completed", kind: "execute",
        input: "capture --window \"Cold start dashboard\"", output: `Saved screenshot to ${screenshot}` });
    }
    this.o.onEvent({ type: "plan", entries: plan(1) });
    // "[hang]" in a request starts a tool call that never finishes until the turn is cancelled, to try (and test)
    // stopping a hung tool call; "[hang-hard]" ignores the cancel too, like an agent stuck on its own tool.
    const hard = request.includes("[hang-hard]");
    const told = /stopped (?:your tool call|it \(tool call timeout\))/.test(text); // after a stop, don't repeat the hung call
    if (!told && (hard || request.includes("[hang]"))) {
      this.o.onEvent({ type: "tool", id: `wait-${this.turn}`, title: "Waiting for the build server", status: "in_progress", kind: "execute", input: "make flash --wait" });
      while (!this.closed && (hard || !this.cancelled)) await new Promise((r) => setTimeout(r, 10));
      if (this.closed) return { stopReason: "error", error: "harness exited (null)." };
      return { stopReason: "cancelled", usage: { tokensIn: estimateTokens(text), tokensOut: 0 } };
    }
    // "[silent]" ends this turn without a word (a reminder gets a normal reply); "[silent-always]" never says anything.
    if (request.includes("[silent-always]")) this.silent = true;
    if (this.silent || request.includes("[silent]")) return { stopReason: "end_turn", usage: { tokensIn: estimateTokens(text), tokensOut: 0 } };
    // "[stall]" goes quiet (no tool call running) until the turn is cancelled, like an agent stuck thinking.
    if (request.includes("[stall]")) {
      while (!this.closed && !this.cancelled) await new Promise((r) => setTimeout(r, 10));
      return this.closed ? { stopReason: "error", error: "harness exited (null)." } : { stopReason: "cancelled", usage: { tokensIn: estimateTokens(text), tokensOut: 0 } };
    }
    const words = reply.split(/(?<=\s)/);
    let k = 0;
    for (const word of words) {
      k++;
      if (k === Math.floor(words.length / 3)) this.o.onEvent({ type: "plan", entries: plan(2) });
      if (k === Math.floor((words.length * 3) / 4)) this.o.onEvent({ type: "plan", entries: plan(3) });
      if (this.cancelled || this.closed) return { stopReason: "cancelled", usage: { tokensIn: estimateTokens(text), tokensOut: 0 } };
      this.o.onEvent({ type: "text", text: word });
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    }
    if (/\b(fix|implement|change|edit|debounce)\b/i.test(request)) {
      this.o.onEvent({ type: "tool", title: "Edit brake_light.c", status: "completed", kind: "edit" });
      this.o.onEvent({ type: "diff", path: "src/brake_light.c", oldText: MOCK_OLD, newText: MOCK_NEW });
      this.o.onEvent({ type: "diff", path: "test/test_brake_light.can", oldText: null, newText: MOCK_TEST });
    }
    this.o.onEvent({ type: "plan", entries: plan(steps.length) });
    return { stopReason: "end_turn", usage: { tokensIn: estimateTokens(text), tokensOut: estimateTokens(reply) } };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  close(): void {
    this.closed = true;
  }
}

export class MockAdapter implements HarnessAdapter {
  readonly id = "mock" as const;
  readonly label = "Mock (offline demo)";
  readonly protocol = "mock" as const;
  constructor(private delayMs = 18) {}

  async listModels() {
    return [{ id: "mock-fast", name: "Mock fast", current: true }, { id: "mock-thorough", name: "Mock thorough" }];
  }

  async detect(): Promise<HarnessStatus> {
    return { id: "mock", label: this.label, available: true, version: "built-in", path: null, protocol: "mock", detail: null };
  }

  async start(o: SessionOptions): Promise<HarnessSession> {
    return new MockSession(o, this.delayMs);
  }
}

// Sample edit for the offline demo (Artifacts → Changes / diff viewer)
const MOCK_OLD = `#include "brake_light.h"

#define BRAKE_ON_DELAY_MS   50u

static uint8 lampState = 0u;

void BrakeLight_MainFunction(void)
{
    boolean pedal = Rte_Read_BrakePedalSw();
    if (pedal) {
        lampState = 1u;
    } else {
        lampState = 0u;
    }
    Rte_Write_BrakeLampOut(lampState);
}
`;
const MOCK_NEW = `#include "brake_light.h"

#define BRAKE_ON_DELAY_MS   50u
#define DEBOUNCE_MS         10u   /* SRS 1102: suppress contact bounce */

static uint8 lampState = 0u;
static uint8 debounceCnt = 0u;

void BrakeLight_MainFunction(void)
{
    boolean pedal = Rte_Read_BrakePedalSw();
    if (pedal) {
        if (debounceCnt < DEBOUNCE_MS) { debounceCnt++; }
    } else {
        debounceCnt = 0u;
    }
    lampState = (debounceCnt >= DEBOUNCE_MS) ? 1u : 0u;
    Rte_Write_BrakeLampOut(lampState);
}
`;
const MOCK_TEST = `/* CAPL test: brake light debounce (SRS 1102) */
testcase TC_BrakeLight_Debounce()
{
  setSignal(BrakePedalSw, 1);
  testWaitForTimeout(5);
  testAssert(getSignal(BrakeLampOut) == 0, "lamp stays off during bounce");
  testWaitForTimeout(10);
  testAssert(getSignal(BrakeLampOut) == 1, "lamp on after debounce");
}
`;

/** A tiny PNG encoder for the mock "screenshot": a dashboard-like gradient with a few bars. */
function mockPng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const bars = [0.35, 0.62, 0.48, 0.8, 0.56, 0.7];
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      let r = 24 + Math.round(40 * x / w), g = 28 + Math.round(30 * y / h), b = 52 + Math.round(70 * x / w);
      const bi = Math.floor((x - 40) / 70);
      const inBar = x >= 40 && bi < bars.length && (x - 40) % 70 < 44 && y > h - 30 - bars[bi]! * (h - 70) && y < h - 30;
      if (inBar) { r = 255 - bi * 18; g = 150 + bi * 12; b = 60 + bi * 30; }
      if (y === h - 30 && x > 30 && x < w - 30) { r = g = b = 190; }
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A main-agent status reply, as A2UI v1.0 or as the plain Markdown an agent writes without it (screenshots, tests). */
export function mockOverview(a2ui: boolean): string {
  const tasks = [
    { icon: "check", title: "Root cause found", detail: "Shared PWM timer resets below 9 V at cold start" },
    { icon: "check", title: "Fix ready for review", detail: "`brake_light.c`: 20 ms debounce on the lamp output" },
    { icon: "warning", title: "HIL run below -10 °C pending", detail: "Cold chamber booked for Thursday" },
  ];
  if (!a2ui) {
    return ["Brake ECU flicker: the cause is found and a fix is ready; one cold-start test is still open.", "",
      "### Where things stand", ...tasks.map((t) => `- **${t.title}**: ${t.detail}`), "",
      "Next step: run the HIL tests, review the fix, or open the RCA report. Which one?"].join("\n");
  }
  const surface = { version: "1.0", createSurface: { surfaceId: "reply-brake-status", catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
    components: [
      { id: "root", component: "Column", children: ["card", "next"] },
      { id: "card", component: "Card", child: "col" },
      { id: "col", component: "Column", children: ["head", "tasks", "div", "stats"] },
      { id: "head", component: "Row", children: ["headIcon", "headText"] },
      { id: "headIcon", component: "Icon", name: "info" },
      { id: "headText", component: "Column", children: ["title", "sub"], weight: 1 },
      { id: "title", component: "Text", text: "### Brake ECU flicker" },
      { id: "sub", component: "Text", variant: "caption", text: { "@call": "formatString", args: { value: "${/done} of ${/total} steps done · updated 14:05" } } },
      { id: "tasks", component: "List", children: { componentId: "task", path: "/tasks" } },
      { id: "task", component: "Row", children: ["taskIcon", "taskText"], align: "start" },
      { id: "taskIcon", component: "Icon", name: { "@path": "icon" } },
      { id: "taskText", component: "Column", children: ["taskTitle", "taskDetail"], weight: 1 },
      { id: "taskTitle", component: "Text", text: { "@path": "title" }, weight: "bold" },
      { id: "taskDetail", component: "Text", variant: "caption", text: { "@path": "detail" } },
      { id: "div", component: "Divider" },
      { id: "stats", component: "Row", justify: "spaceBetween", children: ["s1", "s2", "s3"] },
      { id: "s1", component: "Text", text: "**3** causes checked" },
      { id: "s2", component: "Text", text: "**1** fix ready" },
      { id: "s3", component: "Text", text: "**1** test open" },
      { id: "next", component: "Card", child: "nextCol" },
      { id: "nextCol", component: "Column", children: ["nextTitle", "pick", "acts"] },
      { id: "nextTitle", component: "Text", text: "**What next?**" },
      { id: "pick", component: "ChoicePicker", label: "Include in the HIL run", variant: "multipleSelection", value: { "@path": "/scope" },
        options: [{ label: "-20 °C cold start", value: "cold" }, { label: "Low voltage (8.5 V)", value: "lowv" }, { label: "CAN bus-off", value: "busoff" }] },
      { id: "acts", component: "Row", children: ["run", "review", "report"] },
      { id: "run", component: "Button", variant: "primary", child: "runT", action: { event: { name: "run_hil", userMessage: "Run the HIL tests", context: { scope: { "@path": "/scope" } } } } },
      { id: "runT", component: "Text", text: "Run the HIL tests" },
      { id: "review", component: "Button", child: "reviewT", action: { event: { name: "review_fix", userMessage: "Show me the fix" } } },
      { id: "reviewT", component: "Text", text: "Review the fix" },
      { id: "report", component: "Button", variant: "borderless", child: "reportT", action: { event: { name: "open_report", userMessage: "Open the RCA report" } } },
      { id: "reportT", component: "Text", text: "Open the RCA report" },
    ],
    dataModel: { done: 2, total: 3, tasks, scope: ["cold", "lowv"] } } };
  return ["Brake ECU flicker: the cause is found and a fix is ready; one cold-start test is still open.", "", "```a2ui", JSON.stringify(surface), "```"].join("\n");
}

/** The mock main agent's answer to an A2UI button click: a small confirmation card. */
function mockActionAck(actionJson: string): string {
  let name = "action", ctx: Record<string, unknown> = {};
  try { const a = JSON.parse(actionJson).action; name = String(a.name); ctx = a.context ?? {}; } catch { /* keep the defaults */ }
  const scope = Array.isArray(ctx.scope) ? (ctx.scope as string[]).join(", ") : "";
  const surface = { version: "1.0", createSurface: { surfaceId: `reply-ack-${Date.now().toString(36)}`, catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
    components: [
      { id: "root", component: "Card", child: "row" },
      { id: "row", component: "Row", children: ["ic", "col"], align: "start" },
      { id: "ic", component: "Icon", name: "refresh" },
      { id: "col", component: "Column", children: ["t", "d"], weight: 1 },
      { id: "t", component: "Text", text: `**Started:** ${name.replace(/_/g, " ")}` },
      { id: "d", component: "Text", variant: "caption", text: scope ? `Scope: ${scope}. I'll post the results here when the run finishes.` : "I'll post the result here when it's done." },
    ] } };
  return [`Started ${name.replace(/_/g, " ")} (mock).`, "", "```a2ui", JSON.stringify(surface), "```"].join("\n");
}
