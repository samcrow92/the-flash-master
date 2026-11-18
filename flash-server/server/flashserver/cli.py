"""Command line: python3 -m flashserver <command> [--config FILE] [--data-dir DIR] [--json]."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import signal
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from . import __version__
from .config import load_config
from .core import Service
from .util import ApiError

DATA_ITEMS = ("flash.db", "releases", "marketplace", "submissions")


def _common(p: argparse.ArgumentParser, suppress: bool) -> None:
    d = argparse.SUPPRESS if suppress else None
    p.add_argument("--config", default=d, help="config file (default /etc/flash-server/config.json when it exists)")
    p.add_argument("--data-dir", default=d, help="override dataDir from the config")
    p.add_argument("--json", action="store_true", default=argparse.SUPPRESS if suppress else False, help="print a JSON object on the last line")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="flashserver", description=f"Flash Server {__version__}")
    _common(ap, False)
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    _common(common, True)
    s = sub.add_parser("serve", parents=[common], help="run the HTTP server")
    s.add_argument("--host")
    s.add_argument("--port", type=int)
    s.add_argument("--quiet", action="store_true", help="no per-request log lines")
    s = sub.add_parser("init", parents=[common], help="create the data dir + DB; prints the first admin token once")
    s.add_argument("--admin-name", default="admin")
    s = sub.add_parser("create-user", parents=[common], help="create a user and print its token")
    s.add_argument("name")
    s.add_argument("--admin", action="store_true")
    s = sub.add_parser("import-marketplace", parents=[common], help="publish a plugins-src/ folder as approved plugins")
    s.add_argument("dir")
    s.add_argument("--owner", help="user name that owns the imported plugins (default: first admin)")
    s = sub.add_parser("publish-release", parents=[common], help="upload a local release folder and publish it")
    s.add_argument("dir")
    s.add_argument("--version", required=True)
    s.add_argument("--channel", default="stable", choices=["stable", "beta"])
    s.add_argument("--notes")
    s = sub.add_parser("backup", parents=[common], help="write a .tar.gz of the data dir (consistent DB snapshot)")
    s.add_argument("file", nargs="?")
    s = sub.add_parser("restore", parents=[common], help="restore a backup (stop the service first)")
    s.add_argument("file")
    sub.add_parser("rebuild-index", parents=[common], help="re-hash published packages and rewrite marketplace/index.json")
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    cfg = load_config(a.config, {"dataDir": a.data_dir, "host": getattr(a, "host", None), "port": getattr(a, "port", None)})
    try:
        if a.cmd == "restore":  # must not open the DB that is about to be replaced
            out = restore(Path(cfg["dataDir"]), Path(a.file))
        elif a.cmd == "serve":
            return serve(cfg, a.quiet)
        else:
            svc = Service(cfg)
            try:
                out = run(svc, a)
            finally:
                svc.close()
    except ApiError as e:
        return fail(a, e.message, e.code)
    except (OSError, ValueError, tarfile.TarError) as e:
        return fail(a, str(e), "error")
    code = 1 if out.pop("_failed", False) else 0
    if a.json:
        print(json.dumps(out, ensure_ascii=False))
    else:
        for k, v in out.items():
            print(f"{k}: {v if isinstance(v, (str, int, type(None))) else json.dumps(v, ensure_ascii=False)}")
    return code


def fail(a, msg: str, code: str) -> int:
    print(f"error: {msg}", file=sys.stderr)
    if getattr(a, "json", False):
        print(json.dumps({"error": msg, "code": code}))
    return 1


def run(svc: Service, a) -> dict:
    if a.cmd == "init":
        token = None
        if not svc.has_admin():
            _, token = svc.create_user(a.admin_name, "admin")
            if not a.json:
                print(f"Admin user '{a.admin_name}' created. Token (shown once, keep it safe):\n  {token}")
        return {"adminToken": token, "dataDir": str(svc.data), "version": __version__}
    if a.cmd == "create-user":
        user, token = svc.create_user(a.name, "admin" if a.admin else "user")
        return {"user": user, "token": token}
    if a.cmd == "import-marketplace":
        owner = None
        if a.owner:
            owner = svc.db.one("SELECT * FROM users WHERE name = ?", (a.owner,))
            if not owner:
                raise ApiError(404, "not_found", f"no user {a.owner}")
        out = svc.import_marketplace(Path(a.dir), owner)
        return {**out, "_failed": bool(out["errors"])}
    if a.cmd == "publish-release":
        return svc.publish_release_dir(Path(a.dir), a.version, a.channel, a.notes)
    if a.cmd == "backup":
        return backup(svc, Path(a.file) if a.file else None)
    if a.cmd == "rebuild-index":
        return svc.rebuild_index()
    raise ValueError(f"unknown command {a.cmd}")


def serve(cfg: dict, quiet: bool) -> int:
    from .web import make_server
    svc = Service(cfg)
    srv = make_server(svc, cfg["host"], cfg["port"], quiet)
    signal.signal(signal.SIGTERM, _stop)
    print(f"flash-server {__version__} listening on http://{cfg['host']}:{srv.server_address[1]} "
          f"(data {svc.data}, publicRead={cfg['publicRead']})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        svc.close()
    return 0


def _stop(*_):
    raise KeyboardInterrupt


def backup(svc: Service, file: Path | None) -> dict:
    if file is None:
        file = svc.data / "backups" / f"flash-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.tar.gz"
    file = file.resolve()
    file.parent.mkdir(parents=True, exist_ok=True)
    snap = svc.data / f".backup-{secrets.token_hex(4)}.db"
    tmp = file.parent / f".{file.name}.{secrets.token_hex(4)}.tmp"
    try:
        svc.db.backup_to(snap)
        with tarfile.open(tmp, "w:gz") as tar:
            tar.add(snap, arcname="flash.db")
            for item in DATA_ITEMS[1:]:
                p = svc.data / item
                if p.exists():
                    tar.add(p, arcname=item, filter=lambda ti: None if PurePosixPath(ti.name).name.startswith(".") else ti)
        os.replace(tmp, file)
    finally:
        for p in (snap, tmp):
            if p.exists():
                p.unlink()
    return {"file": str(file), "size": file.stat().st_size}


def _safe_members(tar: tarfile.TarFile) -> list[tarfile.TarInfo]:
    out = []
    for m in tar.getmembers():
        parts = PurePosixPath(m.name).parts
        if m.name.startswith(("/", "\\")) or ".." in parts or ":" in m.name or "\\" in m.name or not parts:
            raise ValueError(f"unsafe path in backup: {m.name}")
        if parts[0] not in DATA_ITEMS:
            raise ValueError(f"unexpected entry in backup: {m.name}")
        if not (m.isfile() or m.isdir()):
            raise ValueError(f"links and special files are not allowed in a backup: {m.name}")
        out.append(m)
    return out


def restore(data: Path, file: Path) -> dict:
    """Replace the data dir contents (DB, releases, marketplace, submissions) with a backup. backups/ is kept."""
    data = data.resolve()
    data.mkdir(parents=True, exist_ok=True)
    tmp = data / f".restore-{secrets.token_hex(4)}"
    try:
        with tarfile.open(file, "r:gz") as tar:
            members = _safe_members(tar)
            if not any(m.name == "flash.db" and m.isfile() for m in members):
                raise ValueError("not a flash-server backup (flash.db missing)")
            if hasattr(tarfile, "data_filter"):
                tar.extractall(tmp, members=members, filter="data")
            else:
                tar.extractall(tmp, members=members)  # members were validated above
        for item in DATA_ITEMS:
            dst = data / item
            if dst.is_dir():
                shutil.rmtree(dst)
            elif dst.exists():
                dst.unlink()
            for side in ("-wal", "-shm"):
                if item == "flash.db" and (data / f"flash.db{side}").exists():
                    (data / f"flash.db{side}").unlink()
            if (tmp / item).exists():
                os.replace(tmp / item, dst)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    svc = Service({"dataDir": str(data)})  # runs newer migrations and recreates missing folders
    try:
        out = {"restored": str(file), "dataDir": str(data), "plugins": len(svc.index()["plugins"]), "releases": svc.channels()}
    finally:
        svc.close()
    return out
