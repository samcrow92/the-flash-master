"""Server config: /etc/flash-server/config.json (all keys optional)."""
from __future__ import annotations

import json
from pathlib import Path

DEFAULT_CONFIG = Path("/etc/flash-server/config.json")
DEFAULTS = {"name": "Flash Server", "description": "", "host": "127.0.0.1", "port": 8787, "dataDir": "/var/lib/flash-server", "publicRead": False}


def load_config(path: str | None = None, overrides: dict | None = None) -> dict:
    cfg = dict(DEFAULTS)
    p = Path(path) if path else DEFAULT_CONFIG
    if path or p.is_file():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except OSError as e:
            raise SystemExit(f"cannot read config {p}: {e}") from None
        except ValueError as e:
            raise SystemExit(f"config {p} is not valid JSON: {e}") from None
        if not isinstance(data, dict):
            raise SystemExit(f"config {p} must be a JSON object")
        if "public_read" in data and "publicRead" not in data:
            data["publicRead"] = data["public_read"]
        cfg.update(data)
    cfg.update({k: v for k, v in (overrides or {}).items() if v is not None})
    cfg["port"] = int(cfg["port"])
    cfg["publicRead"] = bool(cfg["publicRead"])
    return cfg
