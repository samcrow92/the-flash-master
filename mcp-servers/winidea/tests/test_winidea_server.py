import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_lists_tools_and_reports_missing_sdk_cleanly():
    env = {**os.environ, "PYTHONPATH": os.path.join(ROOT, "..", "pycommon")}
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "status", "arguments": {}}},
    ]
    p = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, env=env, timeout=30)
    out = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    names = {t["name"] for t in out[1]["result"]["tools"]}
    assert {"connect", "download", "run", "halt", "step", "set_breakpoint", "read_variable", "read_memory", "call_stack", "evaluate"} <= names
    try:
        import isystem.connect  # noqa: F401
    except ImportError:
        assert out[2]["result"]["isError"] is True
        assert "isystem.connect" in out[2]["result"]["content"][0]["text"]
