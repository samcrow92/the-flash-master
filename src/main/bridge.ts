/**
 * Loopback bridge between harness sessions and the app. The bundled MCP servers (flashmaster-core, jazz)
 * are thin stdio processes started by each harness; they forward tool calls here over 127.0.0.1 with a
 * per-launch random token. Tool schemas live here, so there is one source of truth.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  set: "core" | "jazz";
  handler: (args: any, ctx: { agentId: string }) => Promise<unknown>;
}

export class Bridge {
  readonly token = randomBytes(24).toString("hex");
  private server: Server | null = null;
  port = 0;
  private tools = new Map<string, ToolDef>();

  register(defs: ToolDef[]): void {
    for (const d of defs) this.tools.set(d.name, d);
  }

  list(set: string): Omit<ToolDef, "handler" | "set">[] {
    return [...this.tools.values()].filter((t) => t.set === set).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async call(name: string, args: unknown, agentId: string, set?: string): Promise<unknown> {
    const t = this.tools.get(name);
    // A server may only call tools of its own set (the core server cannot reach Jazz tools, and so on).
    if (!t || (set !== undefined && t.set !== set)) throw new Error(`unknown tool ${name}`);
    return t.handler(args ?? {}, { agentId });
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.headers["x-flash-token"] !== this.token) { res.writeHead(401).end(); return; }
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
        req.on("end", async () => {
          try {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (req.method === "GET" && url.pathname === "/tools") {
              return json(res, 200, { tools: this.list(url.searchParams.get("set") ?? "core") });
            }
            if (req.method === "POST" && url.pathname === "/call") {
              const { name, args, agentId, set } = JSON.parse(body || "{}");
              const result = await this.call(name, args, String(agentId ?? ""), String(set ?? ""));
              return json(res, 200, { result });
            }
            json(res, 404, { error: "not found" });
          } catch (e: any) {
            json(res, 200, { error: String(e?.message ?? e) });
          }
        });
      });
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const a = this.server!.address();
        this.port = typeof a === "object" && a ? a.port : 0;
        resolve(this.port);
      });
    });
  }

  stop(): void {
    this.server?.close();
  }
}

function json(res: import("node:http").ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
}
