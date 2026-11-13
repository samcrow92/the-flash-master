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
    this.o.onEvent({ type: "tool", title: "Reading project structure", status: "completed", kind: "read" });
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
