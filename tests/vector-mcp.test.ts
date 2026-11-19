import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bridge } from "../src/main/bridge";
import { McpBootstrap, baseEnv } from "../src/main/mcp";
import { McpClient, VectorMcp, discover, parseEndpoint, readMcpJson, resolveServers, resultText, toolName } from "../src/main/vector-mcp";
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type Settings } from "../src/shared/settings";
import type { RoleDef } from "../src/shared/types";

const tmp = () => mkdtempSync(join(tmpdir(), "vector-mcp-"));

/** A stdio MCP server like Vector's: initialize, tools/list, tools/call (one tool fails on purpose). */
function fakeStdioServer(dir: string): string {
  const file = join(dir, "fake-canoe-mcp.mjs");
  writeFileSync(file, `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "CANoe" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [
    { name: "start_measurement", description: "Start the CANoe measurement.", inputSchema: { type: "object", properties: {} } },
    { name: "get_signal", description: "Read a signal value.", inputSchema: { type: "object", properties: { signal: { type: "string" } }, required: ["signal"] } },
    { name: "broken", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  ] } });
  if (m.method === "tools/call") {
    const { name, arguments: a } = m.params;
    if (name === "broken") return send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "no configuration loaded" }] } });
    if (name === "get_signal") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: a.signal + " = 1" }] } });
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "measurement running" }] } });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
});`);
  return file;
}

function settingsWith(v: DeepPartial<Settings["vector"]>, extra: DeepPartial<Settings> = {}): Settings {
  return mergeSettings(mergeSettings(DEFAULT_SETTINGS, { agents: { toolMode: "auto" }, vector: v } as any), extra);
}

const noScan = () => ({ configs: [], executables: [] });

describe("Vector MCP: finding the servers", () => {
  it("reads an endpoint setting as a URL or a command line", () => {
    expect(parseEndpoint("vector-canoe", "CANoe", "canoe", " http://127.0.0.1:5005/mcp ")).toMatchObject({ url: "http://127.0.0.1:5005/mcp" });
    expect(parseEndpoint("vector-canoe", "CANoe", "canoe", `"C:\\Program Files\\Vector CANoe 20\\Exec64\\CANoeMcpServer.exe" --stdio`))
      .toMatchObject({ command: "C:\\Program Files\\Vector CANoe 20\\Exec64\\CANoeMcpServer.exe", args: ["--stdio"] });
    expect(parseEndpoint("vector-canoe", "CANoe", "canoe", "  ")).toBeNull();
  });

  it("reads Vector's mcp.json in the VS Code and the mcpServers shapes and tells CANoe from the docs server", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".vscode"));
    const vs = join(dir, ".vscode", "mcp.json");
    writeFileSync(vs, `// CANoe AI Package
{ "servers": {
  "CANoe": { "type": "http", "url": "http://localhost:\${env:CANOE_MCP_PORT}/mcp" },
  "canoe-documentation": { "type": "stdio", "command": "\${workspaceFolder}/docs/CANoeDocsMcp.exe", "args": ["--lang", "en"], "env": { "HOME_DIR": "%USERPROFILE%" } }
} }`);
    const got = readMcpJson(vs, { CANOE_MCP_PORT: "7071", USERPROFILE: "C:\\Users\\mari" });
    expect(got).toEqual([
      expect.objectContaining({ id: "vector-canoe", prefix: "canoe", url: "http://localhost:7071/mcp" }),
      expect.objectContaining({ id: "vector-canoe-docs", prefix: "canoe_docs", command: `${dir}/docs/CANoeDocsMcp.exe`, args: ["--lang", "en"], env: { HOME_DIR: "C:\\Users\\mari" } }),
    ]);
    const claude = join(dir, "claude.json");
    writeFileSync(claude, JSON.stringify({ mcpServers: { canoe: { command: "canoe-mcp" }, off: { command: "x", disabled: true } } }));
    expect(readMcpJson(claude)).toEqual([expect.objectContaining({ id: "vector-canoe", command: "canoe-mcp", args: [] })]);
    expect(readMcpJson(join(dir, "missing.json"))).toEqual([]);
  });

  it("finds Vector's mcp.json and MCP executables below the install folders, skipping installers", () => {
    const dir = tmp();
    mkdirSync(join(dir, "Vector CANoe 20", "Exec64"), { recursive: true });
    mkdirSync(join(dir, "CANoe AI Package", ".vscode"), { recursive: true });
    writeFileSync(join(dir, "Vector CANoe 20", "Exec64", "CANoeMcpServer.exe"), "");
    writeFileSync(join(dir, "Vector CANoe 20", "Exec64", "McpSetup.exe"), "");
    writeFileSync(join(dir, "Vector CANoe 20", "Exec64", "CANoe64.exe"), "");
    writeFileSync(join(dir, "CANoe AI Package", ".vscode", "mcp.json"), JSON.stringify({ servers: { "CANoe Docs": { url: "http://localhost:9/mcp" } } }));
    writeFileSync(join(dir, "unrelated-mcp.json"), JSON.stringify({ servers: { github: { url: "https://x" } } }));
    const found = discover([dir]);
    expect(found.executables).toEqual([join(dir, "Vector CANoe 20", "Exec64", "CANoeMcpServer.exe")]);
    expect(found.configs).toEqual([join(dir, "CANoe AI Package", ".vscode", "mcp.json")]);
  });

  it("explicit settings win over Vector's mcp.json, which wins over discovered executables", () => {
    const dir = tmp();
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ servers: { CANoe: { url: "http://from-json/mcp" }, "CANoe Help": { url: "http://docs/mcp" } } }));
    const v = settingsWith({ canoeMcp: "http://from-settings/mcp", mcpConfigPath: cfg }).vector;
    const got = resolveServers(v, () => ({ configs: [], executables: [join(dir, "CANoeMcpServer.exe")] }));
    expect(got.map((c) => [c.id, c.url ?? c.command])).toEqual([["vector-canoe", "http://from-settings/mcp"], ["vector-canoe-docs", "http://docs/mcp"]]);
    expect(resolveServers({ ...v, mcpAutoDetect: false, mcpConfigPath: "", canoeMcp: "" }, () => { throw new Error("must not scan"); })).toEqual([]);
  });

  it("names tools with a prefix inside the 64-character tool-name limit", () => {
    expect(toolName("canoe", "start_measurement")).toBe("canoe_start_measurement");
    expect(toolName("canoe", "canoe_stop")).toBe("canoe_stop");
    expect(toolName("canoe_docs", "search docs.v2")).toBe("canoe_docs_search_docs_v2");
    expect(toolName("canoe", "x".repeat(100))).toHaveLength(64);
    expect(resultText({ content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }] })).toBe("a\n[image image/png]");
    expect(resultText({ content: [], structuredContent: { v: 1 } })).toBe('{"v":1}');
  });
});

describe("Vector MCP: connecting and giving the tools to every agent", () => {
  let http: Server | null = null;
  let vm: VectorMcp | null = null;
  afterEach(() => { vm?.close(); vm = null; http?.close(); http = null; });

  const role = (tools: string[] = []): RoleDef => ({ name: "reviewer", title: "Reviewer", icon: "", description: "", tools, maxResultTokens: 400, skills: [], prompt: "", source: "builtin" } as RoleDef);

  it("connects a stdio server, publishes its tools as the vector set and forwards calls and tool errors", async () => {
    const dir = tmp();
    const server = fakeStdioServer(dir);
    let s = settingsWith({ canoeMcp: `"${process.execPath}" "${server}"`, mcpAutoDetect: false });
    const bridge = new Bridge();
    vm = new VectorMcp({ settings: () => s, baseEnv: () => ({ ...baseEnv(), ELECTRON_RUN_AS_NODE: "1" }), register: (d) => bridge.register(d),
      unregister: (set) => bridge.unregister(set), onStatus: () => {}, scan: noScan });
    await vm.refresh();
    expect(vm.list()).toEqual([expect.objectContaining({ id: "vector-canoe", kind: "vendor", state: "ready", detail: expect.stringContaining("3 tools") })]);
    expect(bridge.list("vector").map((t) => t.name)).toEqual(["canoe_start_measurement", "canoe_get_signal", "canoe_broken"]);
    expect(bridge.list("core")).toEqual([]); // not mixed into the app's own sets
    expect(await bridge.call("canoe_get_signal", { signal: "BrakeLight" }, "a1", "vector")).toBe("BrakeLight = 1");
    await expect(bridge.call("canoe_broken", {}, "a1", "vector")).rejects.toThrow("no configuration loaded");
    await expect(bridge.call("canoe_get_signal", {}, "a1", "core")).rejects.toThrow(/unknown tool/); // a set reaches only its own tools

    // Every agent's MCP list gets the bundled vector forwarder (it reaches the tools through the bridge).
    const data = tmp();
    const boot = new McpBootstrap({ nodeEntry: (n) => `/app/mcp-${n}.mjs`, nodeExec: "/electron", nodeEnv: { ELECTRON_RUN_AS_NODE: "1" }, pythonSrc: "/none", dataDir: data }, () => s, () => {});
    boot.setVendor({ list: () => vm!.list(), tools: () => vm!.toolCount() });
    boot.setBridge("http://127.0.0.1:1", "tok");
    const spec = boot.specsFor(role(), "agent-1").find((x) => x.name === "vector");
    expect(spec).toMatchObject({ command: "/electron", args: ["/app/mcp-vector.mjs", "--bridge", "http://127.0.0.1:1", "--token", "tok", "--agent", "agent-1"] });
    expect(boot.list().find((x) => x.id === "vector-canoe")).toMatchObject({ kind: "vendor", state: "ready" });
    // Text mode (and Duo/Pi) reach them as TOOL lines instead, so no MCP server is sent.
    s = mergeSettings(s, { agents: { toolMode: "text" } } as any);
    expect(boot.specsFor(role(), "agent-1").some((x) => x.name === "vector")).toBe(false);

    // Switching the server off in Settings → MCP servers withdraws its tools.
    s = mergeSettings(s, { agents: { toolMode: "auto" }, mcp: { disabled: ["vector-canoe"] } } as any);
    await vm.refresh();
    expect(bridge.list("vector")).toEqual([]);
    expect(boot.specsFor(role(), "agent-1").some((x) => x.name === "vector")).toBe(false);
  }, 20000);

  it("speaks MCP Streamable HTTP: keeps the session id and reads answers sent as SSE", async () => {
    const seen: { method: string; session?: string }[] = [];
    http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        if (req.method === "DELETE") { res.writeHead(200).end(); return; }
        const m = JSON.parse(body);
        seen.push({ method: m.method, session: req.headers["mcp-session-id"] as string | undefined });
        if (m.id === undefined) { res.writeHead(202).end(); return; }
        if (m.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-42" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "CANoe Docs" } } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (m.method === "tools/list") {
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "search_documentation", description: "Search the CANoe help.", inputSchema: { type: "object" } }] } })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `hits for ${m.params.arguments.query}` }] } })}\n\n`);
        }
      });
    });
    await new Promise<void>((r) => http!.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as any).port;
    const client = new McpClient({ id: "vector-canoe-docs", label: "Docs", prefix: "canoe_docs", url: `http://127.0.0.1:${port}/mcp`, source: "test" }, {});
    const tools = await client.connect();
    expect(tools.map((t) => t.name)).toEqual(["search_documentation"]);
    expect(await client.call("search_documentation", { query: "CAPL on message" }, 5000)).toBe("hits for CAPL on message");
    expect(seen.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(seen.slice(1).every((x) => x.session === "s-42")).toBe(true);
    client.close();
  });

  it("says what is missing when no Vector server is installed, and connects nothing when turned off", async () => {
    let s = settingsWith({ mcpAutoDetect: true });
    const bridge = new Bridge();
    vm = new VectorMcp({ settings: () => s, baseEnv: () => ({}), register: (d) => bridge.register(d), unregister: (set) => bridge.unregister(set), onStatus: () => {}, scan: noScan });
    await vm.refresh();
    expect(vm.list()).toEqual([expect.objectContaining({ id: "vector-canoe", state: "missing", detail: expect.stringContaining("CANoe 20 SP2") })]);
    expect(vm.toolCount()).toBe(0);
    s = settingsWith({ mcpEnabled: false });
    await vm.refresh();
    expect(vm.list()).toEqual([]);
  });

  it("reports a server that cannot start instead of hanging", async () => {
    const s = settingsWith({ canoeMcp: join(tmp(), "does-not-exist.exe"), mcpAutoDetect: false });
    vm = new VectorMcp({ settings: () => s, baseEnv: () => baseEnv(), register: () => {}, unregister: () => {}, onStatus: () => {}, scan: noScan });
    await vm.refresh();
    expect(vm.list()[0]).toMatchObject({ id: "vector-canoe", state: "error", detail: expect.stringMatching(/cannot start|exited/) });
  });
});
