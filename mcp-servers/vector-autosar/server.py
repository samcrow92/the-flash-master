"""vector-autosar MCP server: targeted queries over DBC, ARXML, CDD and CAPL, plus CANoe and DaVinci automation."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp_stdio import McpServer  # noqa: E402
import toolchain  # noqa: E402
import vector_tools as vt  # noqa: E402

S = McpServer("vector-autosar")


def schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


P = {"type": "string", "description": "absolute file path"}


@S.tool("DBC overview: version, nodes, message/signal counts per sender.", schema({"path": P}, ["path"]))
def dbc_summary(path): return vt.dbc_summary(path)


@S.tool("Find DBC messages/signals by regex name. kind: any|message|signal.",
        schema({"path": P, "pattern": {"type": "string"}, "kind": {"type": "string", "enum": ["any", "message", "signal"]}}, ["path", "pattern"]))
def dbc_find(path, pattern, kind="any"): return vt.dbc_find(path, pattern, kind)


@S.tool("One DBC message (by name or id, e.g. 0x1A0): DLC, sender, cycle time, signal layout, scaling, receivers, value tables.",
        schema({"path": P, "message": {"type": "string"}}, ["path", "message"]))
def dbc_message(path, message): return vt.dbc_message(path, message)


@S.tool("Decode a raw CAN payload (hex) with the DBC (needs cantools).",
        schema({"path": P, "message": {"type": "string"}, "data_hex": {"type": "string"}}, ["path", "message", "data_hex"]))
def dbc_decode(path, message, data_hex): return vt.dbc_decode(path, message, data_hex)


@S.tool("ARXML overview: schema, package tree, element type counts.", schema({"path": P, "depth": {"type": "integer"}}, ["path"]))
def arxml_summary(path, depth=2): return vt.arxml_summary(path, depth)


@S.tool("Find ARXML elements by SHORT-NAME regex and/or type tag (e.g. APPLICATION-SW-COMPONENT-TYPE, I-SIGNAL, ECU-INSTANCE).",
        schema({"path": P, "name": {"type": "string"}, "type": {"type": "string"}, "limit": {"type": "integer"}}, ["path"]))
def arxml_find(path, name="", type="", limit=40): return vt.arxml_find(path, name, type, limit)


@S.tool("Show one ARXML element by its path (/Pkg/Sub/Name) as a compact tree, depth-limited (default 2).",
        schema({"path": P, "element": {"type": "string"}, "depth": {"type": "integer"}}, ["path", "element"]))
def arxml_element(path, element, depth=2): return vt.arxml_element(path, element, depth)


@S.tool("Which ARXML elements reference the given element path.", schema({"path": P, "element": {"type": "string"}}, ["path", "element"]))
def arxml_refs(path, element): return vt.arxml_refs(path, element)


@S.tool("CANdela CDD overview: ECU, diagnostic classes, DTC count, variants.", schema({"path": P}, ["path"]))
def cdd_summary(path): return vt.cdd_summary(path)


@S.tool("List diagnostic services/DIDs/routines in a CDD, optionally filtered by regex.",
        schema({"path": P, "filter": {"type": "string"}}, ["path"]))
def cdd_services(path, filter=""): return vt.cdd_services(path, filter)


@S.tool("Index a CAPL file: includes, variables, event handlers, functions/testcases.", schema({"path": P}, ["path"]))
def capl_index(path): return vt.capl_index(path)


@S.tool("Static checks on a CAPL file: balance, timers, duplicate functions, missing includes.", schema({"path": P}, ["path"]))
def capl_lint(path): return vt.capl_lint(path)


@S.tool("CANoe status via COM: version, loaded configuration, measurement state (Windows).", schema({}, []))
def canoe_status(): return toolchain.canoe_status()


@S.tool("Run CANoe test environments (optionally open a .cfg first) and return verdicts (Windows).",
        schema({"config": {"type": "string"}, "environment": {"type": "string"}, "timeout_s": {"type": "integer"}}, []))
def canoe_run_test(config="", environment="", timeout_s=600): return toolchain.canoe_run_test(config, environment, timeout_s)


@S.tool("Run the DaVinci Configurator command line with the given arguments (e.g. project validation/generation).",
        schema({"args": {"type": "string"}, "cwd": {"type": "string"}}, ["args"]))
def davinci_cli(args, cwd=""): return toolchain.davinci_cli(args, cwd)


if __name__ == "__main__":
    S.run()
