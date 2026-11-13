// Fake `pi --mode rpc` for tests (protocol per Pi docs/rpc.md).
let buf = "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const args = process.argv.slice(2);
let aborted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (cmd.type === "get_state") out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/s.jsonl", sessionId: "abc", isStreaming: false, args, model: { provider: "anthropic", id: "claude-sonnet-4-5" } } });
    else if (cmd.type === "get_available_models") out({ id: cmd.id, type: "response", command: "get_available_models", success: true, data: { models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 200000 }, { id: "gpt-5", name: "GPT-5", provider: "openai" }] } });
    else if (cmd.type === "abort") { aborted = true; out({ id: cmd.id, type: "response", command: "abort", success: true }); }
    else if (cmd.type === "prompt") {
      aborted = false;
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.c" } });
      out({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {}, isError: false });
      const words = ["Pi ", "says hi ", args.includes("--tools") ? "(read-only) " : "", "done."];
      for (const w of words) {
        if (aborted) break;
        out({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: w } });
        await new Promise((r) => setTimeout(r, cmd.message.includes("SLOW") ? 120 : 1));
      }
      out({ type: "message_end", message: { role: "assistant", stopReason: aborted ? "aborted" : "stop", usage: { input: 200, output: 40, cacheRead: 50, cacheWrite: 0 } } });
      out({ type: "agent_end", messages: [] });
    } else out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown" });
  }
});
