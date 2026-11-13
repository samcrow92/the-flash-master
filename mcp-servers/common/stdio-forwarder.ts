/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC) that forwards tool calls to the
 * TheFlashMaster bridge. No SDK dependency: keeps the bundled server tiny and fast to start.
 * Env: FLASH_BRIDGE_URL, FLASH_BRIDGE_TOKEN, FLASH_AGENT_ID.
 */
import { createInterface } from "node:readline";
import { request } from "node:http";

/**
 * HTTP to the app with node:http rather than fetch: undici's fetch aborts after 5 minutes without response headers,
 * but a delegation waits for a whole specialist run. GETs are retried on transient socket errors.
 */
function httpJson(url: string, token: string, path: string, body?: unknown): Promise<any> {
  const u = new URL(url + path);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: data ? "POST" : "GET", agent: false,
      headers: { "x-flash-token": token, "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`bridge HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.setTimeout(0);
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

export function createForwarder(set: string, serverName: string, env: { url: string; token: string; agentId: string },
  notify?: (msg: unknown) => void) {
  const { url, token, agentId } = env;

  async function bridge(path: string, body?: unknown): Promise<any> {
    if (!url) throw new Error("FLASH_BRIDGE_URL missing — the harness did not pass the environment to this MCP server");
    for (let attempt = 0; ; attempt++) {
      try { return await httpJson(url, token, path, body); }
      catch (e: any) {
        const transient = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed/i.test(String(e?.code ?? "") + String(e?.message ?? ""));
        if (!transient || body !== undefined || attempt >= 3) throw new Error(`cannot reach TheFlashMaster (${e?.code ?? e?.message ?? e})`, { cause: e });
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  async function handle(msg: any): Promise<unknown> {
    switch (msg.method) {
      case "initialize":
        return { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "0.1.0" } };
      case "ping":
        return {};
      case "tools/list":
        return { tools: (await bridge(`/tools?set=${set}&agent=${encodeURIComponent(agentId)}`)).tools };
      case "tools/call": {
        // Long calls (delegations) send MCP progress notifications so the client does not time out.
        const token = msg.params?._meta?.progressToken;
        let n = 0;
        const keepAlive = token !== undefined && notify
          ? setInterval(() => notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++n, message: "working…" } }), 15000)
          : null;
        let r: any;
        try { r = await bridge("/call", { name: msg.params?.name, args: msg.params?.arguments ?? {}, agentId, set }); }
        finally { if (keepAlive) clearInterval(keepAlive); }
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
  // Bridge settings come from the environment, or from --bridge/--token/--agent arguments (harnesses that drop env).
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? "" : ""; };
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const handle = createForwarder(set, serverName, {
    url: process.env.FLASH_BRIDGE_URL || arg("bridge"), token: process.env.FLASH_BRIDGE_TOKEN || arg("token"), agentId: process.env.FLASH_AGENT_ID || arg("agent"),
  }, send);

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
