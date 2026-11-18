"""Higher-level server operations built on an SshSession (or anything with the same methods)."""
from __future__ import annotations

import json
import os
import posixpath
import tempfile
import time
from typing import Callable, Optional

from . import packaging, remote

LineFn = Callable[[str], None]
ProgressFn = Callable[[int, int], None]


def _noop(*_a) -> None:
    pass


def install_server(session, root: str, *, port: Optional[int] = None, bind_public: bool = False,
                   open_firewall: bool = False, on_line: LineFn = _noop,
                   progress: ProgressFn = _noop) -> dict:
    """Pack, upload and run install.sh. Returns the parsed final JSON line (has `adminToken` on first install)."""
    with tempfile.TemporaryDirectory(prefix="flash-admin-") as tmp:
        bundle = os.path.join(tmp, "flash-server.tar.gz")
        names = packaging.build_bundle(root, bundle)
        on_line(f"» packed {len(names)} files ({packaging.human_size(os.path.getsize(bundle))}) from {root}")
        workdir = session.mktemp_dir()
        rbundle = posixpath.join(workdir, "flash-server.tar.gz")
        on_line(f"» uploading to {rbundle}")
        session.put(bundle, rbundle, progress)
    cmd = remote.install_command(workdir, "flash-server.tar.gz", port, bind_public, open_firewall)
    on_line("» sudo bash deploy/install.sh " + cmd.split("install.sh", 1)[1].strip())
    try:
        code, out = session.exec(cmd, sudo=True, on_line=on_line)
    finally:
        try:
            session.exec(f"rm -rf {remote.q(workdir)}")
        except Exception:
            pass
    if code != 0:
        raise RuntimeError(f"install.sh failed with exit code {code}")
    result = packaging.parse_last_json(out) or {}
    return result


def service_status(session) -> dict:
    _, out = session.exec(remote.STATUS_COMMAND)
    return remote.parse_status(out)


def service_action(session, action: str) -> dict:
    session.run(remote.systemctl(action), sudo=True)
    time.sleep(0.6)
    return service_status(session)


def check_prereqs(session) -> list:
    _, out = session.exec(remote.PREREQ_COMMAND)
    return remote.evaluate_prereqs(out)


def read_config(session) -> str:
    return session.run(f"cat {remote.CONFIG}", sudo=True)


def write_config(session, text: str) -> None:
    json.loads(text)  # refuse to write broken JSON
    workdir = session.mktemp_dir()
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json", encoding="utf-8") as fh:
        fh.write(text if text.endswith("\n") else text + "\n")
        local = fh.name
    try:
        session.put(local, posixpath.join(workdir, "config.json"))
        session.run(f"cp {remote.q(workdir)}/config.json {remote.CONFIG} && rm -rf {remote.q(workdir)}", sudo=True)
    finally:
        os.unlink(local)


def run_cli(session, sub: str, *args: str, on_line: LineFn = _noop) -> dict:
    code, out = session.exec(remote.cli(sub, *args), sudo=True, sudo_user=remote.SERVICE_USER, on_line=on_line)
    result = packaging.parse_last_json(out)
    if code != 0:
        msg = (result or {}).get("error") or "\n".join(out.strip().splitlines()[-3:]) or f"exit {code}"
        raise RuntimeError(f"flashserver {sub} failed: {msg}")
    return result or {}


def backup(session, local_path: str, on_line: LineFn = _noop, progress: ProgressFn = _noop) -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rfile = f"{remote.DATA_DIR}/backups/flash-backup-{stamp}.tar.gz"
    on_line(f"» flashserver backup {rfile}")
    run_cli(session, "backup", rfile, on_line=on_line)
    workdir = session.mktemp_dir()
    user = session.profile.user or "$(id -un)"
    session.run(f"install -m 644 -o {user} {rfile} {workdir}/backup.tar.gz", sudo=True)
    on_line(f"» downloading to {local_path}")
    session.get(f"{workdir}/backup.tar.gz", local_path, progress)
    session.exec(f"rm -rf {remote.q(workdir)}")
    return local_path


def restore(session, local_path: str, on_line: LineFn = _noop, progress: ProgressFn = _noop) -> dict:
    workdir = session.mktemp_dir()
    rfile = f"{workdir}/restore.tar.gz"
    on_line(f"» uploading {os.path.basename(local_path)}")
    session.put(local_path, rfile, progress)
    on_line("» stopping service")
    session.run(remote.systemctl("stop"), sudo=True)
    try:
        result = run_cli(session, "restore", rfile, on_line=on_line)
    finally:
        on_line("» starting service")
        session.exec(remote.systemctl("start"), sudo=True)
        session.exec(f"rm -rf {remote.q(workdir)}")
    return result


def import_marketplace(session, local_dir: str, on_line: LineFn = _noop, progress: ProgressFn = _noop) -> dict:
    files = packaging.marketplace_files(local_dir)
    if not files:
        raise RuntimeError(f"{local_dir} is empty")
    workdir = session.mktemp_dir()
    target = f"{workdir}/marketplace"
    on_line(f"» uploading {len(files)} files to {target}")
    session.put_tree(files, target, progress)
    session.exec(f"chmod -R a+rX {remote.q(workdir)}")
    try:
        return run_cli(session, "import-marketplace", target, on_line=on_line)
    finally:
        session.exec(f"rm -rf {remote.q(workdir)}")


def upload_release(api, folder: str, version: str, channel: str, notes: str,
                   on_line: LineFn = _noop, progress: ProgressFn = _noop) -> dict:
    scan = packaging.scan_release_folder(folder)
    files = scan["files"]
    if not files:
        raise RuntimeError(f"No files in {folder}")
    total = sum(scan["sizes"].values()) or 1
    done = 0
    for name in files:
        path = os.path.join(folder, name)
        on_line(f"» PUT {name} ({packaging.human_size(scan['sizes'][name])})")
        base = done
        api.upload_release_file(version, path, progress=lambda a, _b, base=base: progress(base + a, total))
        done += scan["sizes"][name]
    on_line(f"» publish {version} → {channel}")
    return api.publish_release(version, channel, notes)
