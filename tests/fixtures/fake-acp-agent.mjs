// A fake ACP agent for tests: streams chunks, asks permission, reads a file through the client, reports usage.
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let nextId = 1000;
const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ id, method, params }); });
let cancelled = false;
let netFails = 0;
let model = "gpt-5";
let thinking = "medium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id); return; }
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: false } } });
    case "session/new":
      if (process.env.FAKE_COMMANDS !== "none") setTimeout(() => send({ method: "session/update", params: { sessionId: "sess-0",
        update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "usage", description: "Show usage" }, { name: "model", description: "" }] } } }), 20);
      return reply({ sessionId: "sess-" + (msg.params.mcpServers?.length ?? 0),
      models: { currentModelId: "gpt-5", availableModels: [{ modelId: "gpt-5", name: "GPT-5" }, { modelId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }] },
      configOptions: [{ id: "reasoning_effort", name: "Reasoning", type: "select", category: "thought_level", currentValue: "medium",
        options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] }] });
    case "session/load":
      // FAKE_LOAD=1: resumes sessions, replaying the old conversation first (as ACP agents do).
      if (process.env.FAKE_LOAD !== "1") return send({ id: msg.id, error: { code: -32601, message: "loadSession not supported" } });
      send({ method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY " } } } });
      return reply({});
    case "session/set_config_option": thinking = msg.params.value; return reply({ configOptions: [] });
    case "session/set_model": model = msg.params.modelId; return reply({});
    case "session/cancel": cancelled = true; return;
    case "session/prompt": {
      cancelled = false;
      const sid = msg.params.sessionId;
      const text = msg.params.prompt[0].text;
      const upd = (update) => send({ method: "session/update", params: { sessionId: sid, update } });
      // CRASHONCE: the process dies mid-reply the first time (a marker file in the cwd remembers it); CRASHALWAYS: every
      // time, unless started with --steady (a second harness in the tests).
      const marker = join(process.cwd(), ".fake-crashed");
      if ((text.includes("CRASHONCE") && !existsSync(marker)) || (text.includes("CRASHALWAYS") && !process.argv.includes("--steady"))) {
        writeFileSync(marker, "1");
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial answer " } });
        return setTimeout(() => process.exit(3), 20);
      }
      if (text.includes("interrupted because the agent process exited")) upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(continuing) " } });
      if (text.includes("NETFAIL") && netFails < 1) { netFails++; return send({ id: msg.id, error: { code: -32603, message: "Connection error.: other side closed (UND_ERR_SOCKET)" } }); }
      // Text-mode tools: an agent without the app's tools writes TOOL lines.
      if (text.includes("## Tool results")) {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Tool says: ${text.includes("task-1") ? "task-1 created" : "nothing"}` } });
        return reply({ stopReason: "end_turn" });
      }
      if (text.includes("TheFlashMaster tools (text mode)") && text.includes("TEXTTOOL")) {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: 'Creating the task.\nTOOL create_task {"title": "Check debounce",\n "priority": "high"}\n' } });
        return reply({ stopReason: "end_turn" });
      }
      // Text-mode delegation: a coordinator without the delegate tool writes DELEGATE lines.
      if (text.includes("## Specialist results")) {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Integrated: ${text.includes("### reviewer") ? "reviewer result received" : "nothing"}` } });
        return reply({ stopReason: "end_turn" });
      }
      if (text.includes("DELEGATE <role>:")) {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Plan: one review.\n\nDELEGATE reviewer: Review brake.c\nfocus on debounce\n\nDELEGATE nosuchrole: x\n" } });
        return reply({ stopReason: "end_turn" });
      }
      if (text.includes("SEGMENTS")) {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me check the tests." } });
        upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The failure is probably " } });
        upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "in the debounce." } });
        upd({ sessionUpdate: "tool_call", toolCallId: "s1", title: "Run tests", kind: "execute", status: "completed", rawInput: { command: "ctest" } });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "They pass now." } });
        return reply({ stopReason: "end_turn" });
      }
      if (text.includes("RUNCMD")) {
        upd({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Run tests", kind: "execute", status: "pending", rawInput: { command: ["ctest", "--output-on-failure"] } });
        upd({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "Test #1: brake ... Passed" } }] });
        upd({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Test #1: brake ... Passed\n100% tests passed" } }] });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Tests ran." } });
        return reply({ stopReason: "end_turn" });
      }
      if (text.includes("SAYNODELEGATE")) {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I couldn't delegate this: TheFlashMaster's `delegate` tool didn't load in this session, so no task was started." } });
        return reply({ stopReason: "end_turn" });
      }
      if (text === "/usage") {
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Usage:\n  Total usage est:        7 Premium requests\n  API time spent:         3s\n  claude-sonnet-4.5       453.0k in, 13.1k out, 405.7k cached (Est. 5 Premium requests)\n  gpt-5                   1.2k in, 300 out (Est. 2 Premium requests)\n" } });
        return reply({ stopReason: "end_turn" });
      }
      upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "pending" });
      if (text.includes("READFILE:")) {
        const path = text.split("READFILE:")[1].trim().split(/\s/)[0];
        const r = await request("fs/read_text_file", { sessionId: sid, path });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `file says: ${r?.content ?? r?.message} ` } });
      }
      if (text.includes("EDITDIFF")) {
        upd({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed",
          content: [{ type: "diff", path: msg.params.cwd ? msg.params.cwd + "/src/a.c" : "/proj/src/a.c", oldText: "int t = 50;\nint x;\n", newText: "int t = 100;\nint x;\nint y;\n" }] });
        upd({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed",
          content: [{ type: "diff", path: "/proj/src/a.c", oldText: "int t = 50;\nint x;\n", newText: "int t = 100;\nint x;\nint y;\n" }] });
      }
      if (text.includes("WRITEFILE:")) {
        const path = text.split("WRITEFILE:")[1].trim().split(/\s/)[0];
        await request("fs/write_text_file", { sessionId: sid, path, content: "hello v2\n" });
      }
      if (text.includes("which model")) upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `model=${model} thinking=${thinking} ` } });
      const blocks = msg.params.prompt;
      if (blocks.length > 1) upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `blocks=${blocks.map((b) => b.type).join(",")} ` } });
      if (text.includes("WRITE")) {
        const perm = await request("session/request_permission", { sessionId: sid, toolCall: { toolCallId: "t2", title: "Edit main.c", kind: "edit" },
          options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission=${perm.outcome.optionId ?? perm.outcome.outcome} ` } });
      }
      for (const w of ["Hello ", "from ", "fake ", "ACP. "]) {
        if (cancelled) return reply({ stopReason: "cancelled" });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: w } });
        await sleep(text.includes("SLOW") ? 150 : 1);
      }
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "<result>\nsummary: fake done\nfindings:\n- a.c:1 ok\nartifacts: none\n</result>" } });
      return reply({ stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 30 } });
    }
    default: return send({ id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
