// vector MCP server: the tools of Vector's official MCP servers (CANoe MCP Server, CANoe Documentation MCP Server).
// The app holds the one connection to CANoe and forwards each call; see src/main/vector-mcp.ts.
import { runForwarder } from "../common/stdio-forwarder";
runForwarder("vector", "vector");
