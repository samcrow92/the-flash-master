/**
 * Offline mock harness — lets the whole app (streaming, threads, pause/stop, dashboard) be tried and tested
 * without any agent CLI installed. Replies are deterministic and include a result block.
 */
import { randomUUID } from "node:crypto";
import type { HarnessStatus } from "@shared/types";
import { estimateTokens } from "../context";
import type { HarnessAdapter, HarnessSession, PromptAttachment, SessionOptions, TurnResult } from "./types";

export class MockSession implements HarnessSession {
  readonly sessionId = `mock-${randomUUID().slice(0, 8)}`;
  private cancelled = false;
  private closed = false;
  private turn = 0;

  constructor(private o: SessionOptions, private delayMs: number) {}

  get alive(): boolean {
    return !this.closed;
  }

  async prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult> {
    this.cancelled = false;
    this.turn += 1;
    const request = /## Request\n([\s\S]*)$/.exec(text)?.[1] ?? text;
    const role = /# Role: (.+)/.exec(text)?.[1] ?? "Mock agent";
    const reply = [
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
      ...(/\b(fix|implement|change|edit|debounce)\b/i.test(request) ? [
        "Proposed change (mock) — also shown in **Artifacts → Changes**:", "",
        "```c", "// file: brake_light.c", ...MOCK_NEW.trimEnd().split("\n"), "```", ""] : []),
      "<result>",
      `summary: Mock run for "${request.trim().slice(0, 60)}" completed.`,
      "findings:",
      "- No real analysis was performed (mock harness).",
      "artifacts: none",
      "</result>",
    ].join("\n");
    const steps = ["Understand the request", "Inspect relevant files", "Draft the answer", "Write the result block"];
    const plan = (done: number) => steps.map((title, i) => ({ title, status: (i < done ? "completed" : i === done ? "in_progress" : "pending") as "completed" | "in_progress" | "pending" }));
    this.o.onEvent({ type: "plan", entries: plan(0) });
    this.o.onEvent({ type: "tool", id: `ls-${this.turn}`, title: "Reading project structure", status: "in_progress", kind: "execute", input: "git ls-files src | head -20" });
    this.o.onEvent({ type: "tool", id: `ls-${this.turn}`, title: "Reading project structure", status: "completed", kind: "execute",
      output: "src/brake_light.c\nsrc/brake_light.h\nsrc/can_signals.c\nsrc/can_signals.h\ntests/test_brake_light.c" });
    this.o.onEvent({ type: "plan", entries: plan(1) });
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
