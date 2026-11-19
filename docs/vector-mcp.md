# Vector's official MCP servers (CANoe)

Vector Informatik publishes two official MCP servers. Both are local, licensed Windows installs, so Flash Master does
not bundle them: it finds them and connects to them, then gives their tools to **every agent and the coordinator**.

| Server | Comes with | What it does |
| --- | --- | --- |
| CANoe MCP Server | CANoe **20 SP2** or later (licensed CANoe install) | Read and change the loaded configuration, control the simulation and measurement, create and run tests, analyse communication |
| CANoe Documentation MCP Server | The free **CANoe AI Package** (vector.com/canoe-ai), CANoe 20 SP2+ | Answers grounded in Vector's CANoe documentation |

Vector does not publish MCP servers for vTESTstudio, PREEvision or DaVinci (as of November 2026). For those, the
bundled `vector-autosar` server keeps covering offline work: DBC, ARXML, CDD, CAPL, CANoe COM automation and the
DaVinci Configurator command line.

## How Flash Master connects

Settings → Integrations → **Vector MCP servers**. Defaults: on, find automatically.

1. **CANoe MCP Server / CANoe Documentation MCP Server**: an `http(s)://…` URL (MCP Streamable HTTP) or a command
   line (stdio). Use these when you know the endpoint from Vector's documentation.
2. **Vector mcp.json**: the `mcp.json` the CANoe AI Package gives to VS Code (or its folder). Both the VS Code shape
   (`servers`) and the Claude/Cursor shape (`mcpServers`) are read; `${env:NAME}`, `%NAME%` and `${workspaceFolder}`
   are expanded.
3. **Find automatically** (Windows): looks below the CANoe install path and the `Vector*` / `CANoe*` folders in
   Program Files, ProgramData, Documents, Public Documents, Local AppData and Downloads (depth 4) for an `mcp.json`
   that names CANoe, or an executable with `mcp` in its name (installers skipped).

The app is the MCP client: one connection serves all agents, so parallel specialists don't each start a CANoe
server. Tools are published as the `vector` set with a prefix: `canoe_…` and `canoe_docs_…`.

- Claude Code, Copilot, OpenCode and Cursor get them through the bundled `vector` MCP server (it forwards to the app).
- GitLab Duo, Pi and text mode get them as `TOOL` lines, like Flash Master's own tools.

The status shows in Settings → MCP servers (kind `vendor`); unticking a server there withdraws its tools. **Reinstall /
check** reconnects, for example after starting CANoe. A call that finds CANoe restarted reconnects once by itself.

## Not verified

No CANoe 20 SP2 install was available while building this. Vector's public pages name the servers and the version
but not the transport, executable name or tool list, so detection is deliberately broad. If the status says
*Not found*, set the endpoint from Vector's CANoe help (MCP Server chapter) by hand.
