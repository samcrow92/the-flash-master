"""Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). Dependency-free.

Usage:
    server = McpServer("name")
    @server.tool("desc", {"type": "object", "properties": {...}, "required": [...]})
    def my_tool(arg1, arg2=None): ...
    server.run()

Tool results are clipped to FLASH_CLIP_CHARS so large outputs never flood an agent's context.
"""
from __future__ import annotations

import inspect
import json
import os
import sys
import traceback
from typing import Any, Callable

CLIP = int(os.environ.get("FLASH_CLIP_CHARS", "6000") or 6000)


def clip(text: str, limit: int = CLIP) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    head = int(limit * 0.7)
    tail = limit - head
    return f"{text[:head]}\n…[{len(text) - head - tail} chars omitted — narrow your query]…\n{text[-tail:]}"


class McpServer:
    def __init__(self, name: str, version: str = "0.1.0") -> None:
        self.name = name
        self.version = version
        self.tools: dict[str, tuple[Callable[..., Any], dict[str, Any]]] = {}

    def tool(self, description: str, schema: dict[str, Any] | None = None):
        def deco(fn: Callable[..., Any]):
            sch = schema or {"type": "object", "properties": {}}
            self.tools[fn.__name__] = (fn, {"name": fn.__name__, "description": description, "inputSchema": sch})
            return fn
        return deco

    def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name not in self.tools:
            return {"content": [{"type": "text", "text": f"Error: unknown tool {name}"}], "isError": True}
        fn, _ = self.tools[name]
        try:
            params = inspect.signature(fn).parameters
            result = fn(**{k: v for k, v in args.items() if k in params})
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str, separators=(",", ":"))
            return {"content": [{"type": "text", "text": clip(text)}]}
        except Exception as e:  # noqa: BLE001 - report every tool failure to the agent
            return {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True}

    def handle(self, msg: dict[str, Any]) -> Any:
        method = msg.get("method")
        params = msg.get("params") or {}
        if method == "initialize":
            return {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                    "serverInfo": {"name": self.name, "version": self.version}}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [meta for _, meta in self.tools.values()]}
        if method == "tools/call":
            return self.call(params.get("name", ""), params.get("arguments") or {})
        raise LookupError(f"method not found: {method}")

    def run(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" not in msg:
                continue
            try:
                out = {"jsonrpc": "2.0", "id": msg["id"], "result": self.handle(msg)}
            except LookupError as e:
                out = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": str(e)}}
            except Exception as e:  # noqa: BLE001
                traceback.print_exc(file=sys.stderr)
                out = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32603, "message": str(e)}}
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
