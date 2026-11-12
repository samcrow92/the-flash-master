"""Windows toolchain automation: CANoe (COM) and DaVinci Configurator (command line)."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from typing import Any

from mcp_stdio import clip


def _canoe():
    if sys.platform != "win32":
        raise RuntimeError("CANoe automation requires Windows")
    try:
        import win32com.client  # type: ignore
    except ImportError as e:
        raise RuntimeError("pywin32 is not installed in the MCP environment") from e
    return win32com.client.Dispatch("CANoe.Application")


def canoe_status() -> dict[str, Any]:
    app = _canoe()
    cfg = app.Configuration
    return {"version": f"{app.Version.major}.{app.Version.minor}.{app.Version.Build}", "configuration": cfg.FullName,
            "measurement_running": bool(app.Measurement.Running)}


def canoe_run_test(config: str = "", environment: str = "", timeout_s: int = 600) -> dict[str, Any]:
    """Open a configuration (optional), start measurement, run test environments, and return the verdicts."""
    app = _canoe()
    if config:
        app.Open(os.path.abspath(config), True, True)
    if not app.Measurement.Running:
        app.Measurement.Start()
        for _ in range(60):
            if app.Measurement.Running:
                break
            time.sleep(0.5)
    verdicts = {0: "not available", 1: "passed", 2: "failed", 3: "none", 4: "inconclusive", 5: "error"}
    results = []
    envs = app.Configuration.TestSetup.TestEnvironments
    for i in range(1, envs.Count + 1):
        env = envs.Item(i)
        if environment and env.Name != environment:
            continue
        env.ExecuteAll()
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            mods = [env.TestModules.Item(j) for j in range(1, env.TestModules.Count + 1)] if hasattr(env, "TestModules") else []
            if all(not getattr(m, "IsRunning", False) for m in mods):
                break
            time.sleep(1)
        mods = [env.TestModules.Item(j) for j in range(1, env.TestModules.Count + 1)] if hasattr(env, "TestModules") else []
        results.append({"environment": env.Name, "modules": [{"name": m.Name, "verdict": verdicts.get(int(m.Verdict), str(m.Verdict))} for m in mods]})
    return {"results": results}


def davinci_cli(args: str, cwd: str = "") -> dict[str, Any]:
    """Run the DaVinci Configurator command line (path from Settings → Integrations → Vector)."""
    exe = os.environ.get("DAVINCI_CLI", "")
    if not exe or not os.path.isfile(exe):
        raise RuntimeError("DaVinci CLI path not configured (Settings → Integrations → Vector)")
    proc = subprocess.run([exe, *args.split()], cwd=cwd or None, capture_output=True, text=True, timeout=1800)
    return {"exit_code": proc.returncode, "output": clip((proc.stdout or "") + (proc.stderr or ""))}
