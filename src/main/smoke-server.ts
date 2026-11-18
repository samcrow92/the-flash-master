/**
 * A tiny stand-in for a Flash server (flash-server/API.md), used only by the smoke driver (FLASH_SMOKE_SERVER) to take
 * the docs screenshots: health/me, the marketplace (marketplace-example plus a few listed-only entries), my submissions,
 * and an update manifest. Answers 401 without the demo token, like the real private server.
 */
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginEntry, Submission } from "@shared/types";

export const STUB_TOKEN = "fs_demo_token_for_screenshots";

export async function startStubServer(exampleDir: string): Promise<{ url: string; server: Server; setStatus: (id: number, patch: Partial<Submission>) => void }> {
  const idx = JSON.parse(readFileSync(join(exampleDir, "index.json"), "utf8")) as { plugins: PluginEntry[] };
  const extra: PluginEntry[] = [
    { id: "unslop-writing", name: "Unslop writing", version: "1.0.2", description: "A /unslop skill that rewrites reports and review comments in plain, specific language.", team: "Tools & Methods",
      kinds: ["skill"], tags: ["writing"], package: "plugins/unslop-writing-1.0.2.json", author: "mari", updated: "2026-11-16" },
    { id: "flash-tools", name: "ECU flash scripts", version: "2.3.0", description: "PowerShell and Python helpers to flash body ECUs over CAN and read back the software version.", team: "Body SW Integration",
      kinds: ["script", "instructions"], tags: ["flash", "can"], package: "plugins/flash-tools-2.3.0.json", author: "ana", updated: "2026-11-17" },
    { id: "can-tools", name: "CAN tools (MCP)", version: "0.9.1", description: "Tool server for DBC lookup, signal decoding and bus statistics, for every agent that works with CAN.", team: "Network",
      kinds: ["mcp", "agent"], tags: ["can", "dbc"], package: "plugins/can-tools-0.9.1.json", author: "mari", updated: "2026-11-12" },
  ];
  const at = (h: number) => new Date(Date.UTC(2026, 10, 18, h, 12)).toISOString();
  const subs: Submission[] = [
    { id: 15, pluginId: "body-sw-test-pack", version: "1.1.0", name: "Body SW — HIL test pack", kinds: ["agent", "workflow", "skill", "script"], status: "approved",
      notes: "Adds the /hil-report skill and collect-logs.py.", feedback: "Nice work — published. Thanks for the log collector.", author: "ana", createdAt: at(7), reviewedAt: at(9), reviewer: "mari" },
    { id: 14, pluginId: "flash-tools", version: "2.4.0", name: "ECU flash scripts", kinds: ["script", "instructions"], status: "pending",
      notes: "flash.ps1 now retries on a busy bus.", feedback: null, author: "ana", createdAt: at(8), reviewedAt: null, reviewer: null },
    { id: 11, pluginId: "diag-notes", version: "0.1.0", name: "Diagnostics notes", kinds: ["instructions"], status: "rejected",
      notes: "", feedback: "Already covered by diag-team-rules 2.1.0 — please propose changes there.", author: "ana", createdAt: at(1), reviewedAt: at(3), reviewer: "mari" },
  ];
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/api/v1/health") return json(res, 200, { ok: true, name: "Body Electronics hub", version: "1.0.0", publicRead: false });
    if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return json(res, 401, { error: "missing or invalid token", code: "unauthorized" });
    if (path === "/api/v1/me") return json(res, 200, { id: 3, name: "ana", role: "user" });
    if (path === "/api/v1/submissions" && req.method === "GET") return json(res, 200, { submissions: [...subs].sort((a, b) => b.id - a.id) });
    if (path === "/api/v1/submissions" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const p = JSON.parse(body).package;
        const s: Submission = { id: 16, pluginId: p.id, version: p.version, name: p.name, kinds: ["agent"], status: "pending", notes: "", feedback: null, author: "ana", createdAt: new Date().toISOString(), reviewedAt: null, reviewer: null };
        subs.push(s);
        json(res, 201, s);
      });
      return;
    }
    const del = /^\/api\/v1\/submissions\/(\d+)$/.exec(path);
    if (del && req.method === "DELETE") { const s = subs.find((x) => x.id === Number(del[1])); if (!s) return json(res, 404, { error: "not found", code: "not_found" }); s.status = "withdrawn"; return json(res, 200, s); }
    if (path === "/marketplace/index.json") return json(res, 200, { name: "Body Electronics hub", description: "Reviewed plugins", plugins: [...idx.plugins.map((p) => ({ ...p, author: "mari" })), ...extra] });
    if (path.startsWith("/marketplace/plugins/")) {
      const f = join(exampleDir, decodeURIComponent(path.slice("/marketplace".length)));
      if (f.startsWith(exampleDir) && existsSync(f)) return res.writeHead(200, { "Content-Type": "application/json" }).end(readFileSync(f));
      return json(res, 404, { error: "not found", code: "not_found" });
    }
    if (path === "/updates/stable/latest.json") return json(res, 200, { version: "0.4.0", date: at(6), notes: "Flash server support: updates, marketplace, submissions.",
      files: [{ kind: "setup", name: "TheFlashMaster-0.4.0-x64-setup.exe", sha256: "0".repeat(64), size: 98765432 }, { kind: "portable", name: "TheFlashMaster-0.4.0-x64-portable.exe", sha256: "0".repeat(64), size: 97654321 }] });
    return json(res, 404, { error: "not found", code: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return { url, server, setStatus: (id, patch) => { const s = subs.find((x) => x.id === id); if (s) Object.assign(s, patch); } };
}
