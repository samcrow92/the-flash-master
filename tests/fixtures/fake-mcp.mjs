// Minimal MCP server for the self-test: answers initialize and tools/list; "--crash" exits at once.
import { createInterface } from "node:readline";
if (process.argv.includes("--crash")) { process.stderr.write("boom: missing SystemRoot\n"); process.exit(3); }
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { capabilities: { tools: {} } } }) + "\n");
  if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "a" }, { name: "b" }] } }) + "\n");
});
