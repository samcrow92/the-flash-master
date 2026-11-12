// A fake ACP agent for tests: streams chunks, asks permission, reads a file through the client, reports usage.
import { createInterface } from "node:readline";

let nextId = 1000;
const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ id, method, params }); });
let cancelled = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id); return; }
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false } });
    case "session/new": return reply({ sessionId: "sess-" + (msg.params.mcpServers?.length ?? 0) });
    case "session/set_model": return send({ id: msg.id, error: { code: -32601, message: "unsupported" } });
    case "session/cancel": cancelled = true; return;
    case "session/prompt": {
      cancelled = false;
      const sid = msg.params.sessionId;
      const text = msg.params.prompt[0].text;
      const upd = (update) => send({ method: "session/update", params: { sessionId: sid, update } });
      upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "pending" });
      if (text.includes("READFILE:")) {
        const path = text.split("READFILE:")[1].trim().split(/\s/)[0];
        const r = await request("fs/read_text_file", { sessionId: sid, path });
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `file says: ${r?.content ?? r?.message} ` } });
      }
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
