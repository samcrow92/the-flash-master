// Runs the Python MCP server tests with whichever Python 3 is available.
import { spawnSync } from "node:child_process";

const candidates = process.platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
for (const [cmd, pre] of candidates) {
  const probe = spawnSync(cmd, [...pre, "-c", "import pytest"], { stdio: "ignore" });
  if (probe.status === 0) {
    const r = spawnSync(cmd, [...pre, "-m", "pytest", "-q", "mcp-servers"], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
}
console.error("Python 3 with pytest not found (pip install pytest cantools).");
process.exit(1);
