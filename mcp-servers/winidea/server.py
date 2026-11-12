"""winidea MCP server: on-target debugging through the iSYSTEM/TASKING winIDEA Python SDK (isystem.connect).

API names were checked against isystem.connect 9.26 (ConnectionMgr, CConnectionConfig, CDebugFacade,
CDataController.getStackFrames, StackFrameVector). One connection is kept for the server's lifetime.
"""
from __future__ import annotations

import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp_stdio import McpServer  # noqa: E402

S = McpServer("winidea")
_state: dict[str, Any] = {"conn": None, "debug": None}


def _ic():
    try:
        import isystem.connect as ic  # type: ignore
    except ImportError as e:
        raise RuntimeError("isystem.connect (winIDEA SDK) is not installed — set Settings → winIDEA → SDK path, or allow the MCP installer to pip-install it") from e
    return ic


def _debug():
    if _state["debug"] is None:
        connect()
    return _state["debug"]


def schema(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


@S.tool("Connect to winIDEA (most recently used instance, or open a workspace .xjrf).", schema({"workspace": {"type": "string"}}))
def connect(workspace: str = "") -> dict[str, Any]:
    ic = _ic()
    conn = ic.ConnectionMgr()
    ws = workspace or os.environ.get("WINIDEA_WORKSPACE", "")
    cfg = ic.CConnectionConfig()
    if ws:
        cfg.workspace(ws)
    winidea = os.environ.get("WINIDEA_PATH", "")
    if winidea and hasattr(cfg, "path"):
        cfg.path(winidea)
    conn.connect(cfg)
    _state["conn"] = conn
    _state["debug"] = ic.CDebugFacade(conn)
    return {"connected": True, "workspace": ws or "(most recent)"}


@S.tool("Target status: running/stopped/reset.")
def status() -> dict[str, Any]:
    st = _debug().getCPUStatus()
    return {"running": bool(st.isRunning()), "stopped": bool(st.isStopped()), "reset": bool(st.isReset()), "mustInit": bool(st.isMustInit())}


@S.tool("Download the application to the target (flash/RAM as configured in winIDEA).")
def download() -> str:
    _debug().download()
    return "download complete"


@S.tool("Reset the target.")
def reset() -> str:
    _debug().reset()
    return "reset"


@S.tool("Run the target; optionally until a function and wait for it to stop.",
        schema({"until_function": {"type": "string"}, "wait_ms": {"type": "integer", "description": "wait for stop, 0 = don't wait"}}))
def run(until_function: str = "", wait_ms: int = 0) -> dict[str, Any]:
    d = _debug()
    if until_function:
        d.runUntilFunction(until_function)
    else:
        d.run()
    if wait_ms:
        d.waitUntilStopped(wait_ms)
    return status()


@S.tool("Halt the target and report where it stopped.")
def halt() -> dict[str, Any]:
    _debug().stop()
    return {"status": status(), "frame": call_stack(active_only=True)}


@S.tool("Step one source line. over=true steps over calls.", schema({"over": {"type": "boolean"}}))
def step(over: bool = True) -> dict[str, Any]:
    d = _debug()
    d.stepOverHigh() if over else d.stepHigh()
    return {"frame": call_stack(active_only=True)}


@S.tool("Set a breakpoint at a function name or file:line.", schema({"location": {"type": "string", "description": "main | src/app.c:120"}}, ["location"]))
def set_breakpoint(location: str) -> str:
    d = _debug()
    if ":" in location and location.rsplit(":", 1)[1].isdigit():
        f, line = location.rsplit(":", 1)
        d.setBP(int(line), f)
    else:
        d.setBP(location)
    return f"breakpoint set at {location}"


@S.tool("Delete all breakpoints.")
def clear_breakpoints() -> str:
    _debug().deleteAll()
    return "all breakpoints deleted"


def _flags(realtime: bool):
    ic = _ic()
    return ic.IConnectDebug.fRealTime if realtime else ic.IConnectDebug.fMonitor


@S.tool("Evaluate a C expression/variable (e.g. 'g_speed', 'buf[3]', 'ptr->field').",
        schema({"expression": {"type": "string"}, "realtime": {"type": "boolean", "description": "read while running (default false)"}}, ["expression"]))
def read_variable(expression: str, realtime: bool = False) -> dict[str, str]:
    v = _debug().evaluate(_flags(realtime), expression)
    return {"expression": expression, "value": v.toString() if hasattr(v, "toString") else str(v)}


@S.tool("Evaluate an arbitrary C expression (same as read_variable).", schema({"expression": {"type": "string"}}, ["expression"]))
def evaluate(expression: str) -> dict[str, str]:
    return read_variable(expression)


@S.tool("Write a variable (state the reason first — this changes target state).",
        schema({"expression": {"type": "string"}, "value": {"type": "string"}}, ["expression", "value"]))
def write_variable(expression: str, value: str) -> str:
    _debug().modify(_flags(False), expression, value)
    return f"{expression} = {value}"


@S.tool("Read a small memory range (max 256 bytes) as hex.",
        schema({"address": {"type": "string", "description": "hex, e.g. 0x20000000"}, "length": {"type": "integer"}, "mem_area": {"type": "integer"}}, ["address"]))
def read_memory(address: str, length: int = 64, mem_area: int = 0) -> dict[str, Any]:
    n = max(1, min(int(length), 256))
    addr = int(address, 16) if str(address).lower().startswith("0x") else int(address)
    d = _debug()
    data = d.readMemory(_flags(False), mem_area, addr, n, 1)
    raw = bytes(int(b) & 0xFF for b in data)
    return {"address": hex(addr), "length": n, "hex": raw.hex(" ")}


@S.tool("Current call stack (function, file, line).", schema({"active_only": {"type": "boolean"}}))
def call_stack(active_only: bool = False) -> list[dict[str, Any]]:
    ic = _ic()
    frames = ic.StackFrameVector()
    _debug().getDataController().getStackFrames(bool(active_only), False, frames)
    out = []
    for f in list(frames)[:30]:
        out.append({"function": f.getFunction() if hasattr(f, "getFunction") else "", "file": f.getFileName(), "line": f.getLineNumber()})
    return out


if __name__ == "__main__":
    S.run()
