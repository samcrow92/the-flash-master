// Fake `pi --mode rpc` for tests (protocol per Pi docs/rpc.md).
let buf = "";
// A prompt containing QUICK answers with its response and the whole run in one write (one stdout chunk), like a fast Pi reply.
let burst = null;
const out = (o) => { if (burst) burst.push(JSON.stringify(o) + "\n"); else process.stdout.write(JSON.stringify(o) + "\n"); };
const args = process.argv.slice(2);
let aborted = false;
let steered = null;
// --linger <ms>: like real Pi, stay "processing" for a moment after agent_end and refuse a prompt without streamingBehavior.
const linger = args.includes("--linger") ? Number(args[args.indexOf("--linger") + 1]) : 0;
let processing = false;
// --provider/--model pick the model get_state reports; FAKE_PI_KNOWN (comma list of provider/id): like Pi, fall back to the default for an unknown model.
const argOf = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const asked = { provider: argOf("--provider") ?? "anthropic", id: argOf("--model") ?? "claude-sonnet-4-5" };
const model = process.env.FAKE_PI_KNOWN && !process.env.FAKE_PI_KNOWN.split(",").includes(`${asked.provider}/${asked.id}`)
  ? { provider: "github-copilot", id: "gpt-6.1-sol" } : asked;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (cmd.type === "get_state") out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "abc", isStreaming: false, args, model } });
    else if (cmd.type === "get_available_models") out({ id: cmd.id, type: "response", command: "get_available_models", success: true, data: { models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 200000 }, { id: "gpt-5", name: "GPT-5", provider: "openai" }] } });
    else if (cmd.type === "steer") { steered = cmd.message; out({ id: cmd.id, type: "response", command: "steer", success: true }); }
    else if (cmd.type === "abort") { aborted = true; out({ id: cmd.id, type: "response", command: "abort", success: true }); }
    else if (cmd.type === "prompt" && processing && !cmd.streamingBehavior) {
      out({ id: cmd.id, type: "response", command: "prompt", success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
    } else if (cmd.type === "prompt") {
      processing = !!linger;
      aborted = false;
      if (cmd.message.includes("QUICK")) burst = [];
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.c" } });
      out({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {}, isError: false });
      const words = ["Pi ", "says\u2028hi ", args.includes("--tools") ? "(read-only) " : "", args.includes("--thinking") ? `(thinking=${args[args.indexOf("--thinking") + 1]}) ` : "",
        cmd.images?.length ? `(images=${cmd.images.length}) ` : "", "done."];
      for (const w of words) {
        if (aborted) break;
        out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: w } });
        if (!burst) await new Promise((r) => setTimeout(r, cmd.message.includes("SLOW") ? 120 : 1));
      }
      // LATESTEER: the run ends before it takes a steering message; real Pi keeps it and injects it at the start of the next run.
      if (steered && !cmd.message.includes("LATESTEER")) {
        out({ type: "turn_start" });
        out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: ` [steered: ${steered}]` } });
        steered = null;
      }
      out({ type: "message_end", message: { role: "assistant", stopReason: aborted ? "aborted" : "stop", usage: { input: 200, output: 40, cacheRead: 50, cacheWrite: 0 } } });
      out({ type: "agent_end", messages: [] });
      if (burst) { process.stdout.write(burst.join("")); burst = null; }
      if (linger) setTimeout(() => { processing = false; }, linger);
    } else out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown" });
  }
});
