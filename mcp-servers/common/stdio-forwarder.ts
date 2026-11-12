/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC) that forwards tool calls to the
 * TheFlashMaster bridge. No SDK dependency: keeps the bundled server tiny and fast to start.
 * Env: FLASH_BRIDGE_URL, FLASH_BRIDGE_TOKEN, FLASH_AGENT_ID.
 */
import { createInterface } from "node:readline";

export function createForwarder(set: string, serverName: string, env: { url: string; token: string; agentId: string }) {
  const { url, token, agentId } = env;

  async function bridge(path: string, body?: unknown): Promise<any> {
    const r = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-flash-token": token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
    return r.json();
  }

  async function handle(msg: any): Promise<unknown> {
    switch (msg.method) {
      case "initialize":
        return { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "0.1.0" } };
      case "ping":
        return {};
      case "tools/list":
        return { tools: (await bridge(`/tools?set=${set}`)).tools };
      case "tools/call": {
        const r = await bridge("/call", { name: msg.params?.name, args: msg.params?.arguments ?? {}, agentId, set });
        if (r.error) return { content: [{ type: "text", text: `Error: ${r.error}` }], isError: true };
        const text = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
        return { content: [{ type: "text", text }] };
      }
      default:
        throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
    }
  }
  return handle;
}

export function runForwarder(set: string, serverName: string): void {
  const handle = createForwarder(set, serverName, {
    url: process.env.FLASH_BRIDGE_URL ?? "", token: process.env.FLASH_BRIDGE_TOKEN ?? "", agentId: process.env.FLASH_AGENT_ID ?? "",
  });
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return; // notifications (initialized, cancelled) need no reply
    handle(msg).then(
      (result) => send({ jsonrpc: "2.0", id: msg.id, result }),
      (e) => send({ jsonrpc: "2.0", id: msg.id, error: { code: e?.code ?? -32603, message: String(e?.message ?? e) } }),
    );
  });
  rl.on("close", () => process.exit(0));
}
