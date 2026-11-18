"""Build the server bundle (tar.gz of flash-server/server + flash-server/deploy) and other local file helpers."""
from __future__ import annotations

import io
import json
import os
import re
import tarfile
import time
from typing import Iterable, List, Optional, Tuple

EXCLUDE_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".git", ".venv", "venv", "node_modules", "tests"}
EXCLUDE_SUFFIXES = (".pyc", ".pyo", ".db", ".db-journal", ".log")
VERSION_RE = re.compile(r"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)")


def find_flash_server_root(start: Optional[str] = None) -> Optional[str]:
    """Locate the folder that holds `server/` and `deploy/` (normally <repo>/flash-server)."""
    here = os.path.abspath(start or os.path.dirname(__file__))
    cur = here
    for _ in range(8):
        for cand in (cur, os.path.join(cur, "flash-server")):
            if is_flash_server_root(cand):
                return cand
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None


def is_flash_server_root(path: str) -> bool:
    return os.path.isdir(os.path.join(path, "server")) and os.path.isfile(os.path.join(path, "deploy", "install.sh"))


def _skip(name: str, is_dir: bool) -> bool:
    if is_dir:
        return name in EXCLUDE_DIRS or name.startswith(".")
    return name.endswith(EXCLUDE_SUFFIXES) or name in (".DS_Store",)


def iter_bundle_files(root: str) -> Iterable[Tuple[str, str]]:
    """(absolute path, archive name) for server/ and deploy/ under root."""
    for top in ("server", "deploy"):
        base = os.path.join(root, top)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if not _skip(d, True))
            for fn in sorted(filenames):
                if _skip(fn, False):
                    continue
                full = os.path.join(dirpath, fn)
                arc = os.path.relpath(full, root).replace(os.sep, "/")
                yield full, arc


def build_bundle(root: str, out_path: str) -> List[str]:
    """Write a reproducible tar.gz with `server/…` and `deploy/…`; returns the member names."""
    if not is_flash_server_root(root):
        raise FileNotFoundError(f"{root} does not contain server/ and deploy/install.sh")
    names: List[str] = []
    mtime = int(time.time())
    with tarfile.open(out_path, "w:gz") as tar:
        for full, arc in iter_bundle_files(root):
            info = tar.gettarinfo(full, arcname=arc)
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = mtime
            # scripts executable, everything else readable (archives built on Windows have no x bit)
            info.mode = 0o755 if arc.endswith(".sh") else 0o644
            with open(full, "rb") as fh:
                data = fh.read()
            if arc.endswith((".sh", ".service", ".py")):
                data = data.replace(b"\r\n", b"\n")  # CRLF from a Windows checkout breaks bash
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
            names.append(arc)
    return names


def parse_last_json(output: str) -> Optional[dict]:
    """The CLI / install.sh print a JSON object as their last stdout line. Over SSH, stderr log lines can arrive
    after it (both streams are merged), so take the last line that is a JSON object rather than the very last line."""
    for line in reversed(output.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return None


def scan_release_folder(folder: str) -> dict:
    """Files to upload + a guessed version/notes (from latest.json or the .exe names)."""
    files = sorted(
        f for f in os.listdir(folder)
        if os.path.isfile(os.path.join(folder, f)) and re.fullmatch(r"[\w.-]+", f) and not f.startswith(".")
    )
    version, notes = "", ""
    manifest = os.path.join(folder, "latest.json")
    if os.path.isfile(manifest):
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                m = json.load(fh)
            version, notes = str(m.get("version", "")), str(m.get("notes", ""))
        except (OSError, ValueError):
            pass
    if not version:
        for f in files:
            if f.lower().endswith(".exe"):
                mm = VERSION_RE.search(f)
                if mm:
                    version = mm.group(1)
                    break
    # upload binaries first, manifests last
    files.sort(key=lambda f: (f in ("latest.json", "SHA256SUMS.txt"), f))
    sizes = {f: os.path.getsize(os.path.join(folder, f)) for f in files}
    return {"files": files, "sizes": sizes, "version": version, "notes": notes}


def walk_tree(local_root: str) -> List[Tuple[str, str]]:
    """(local path, posix relative path) of every file under local_root, skipping caches."""
    out: List[Tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(local_root):
        dirnames[:] = sorted(d for d in dirnames if not _skip(d, True))
        for fn in sorted(filenames):
            if _skip(fn, False):
                continue
            full = os.path.join(dirpath, fn)
            out.append((full, os.path.relpath(full, local_root).replace(os.sep, "/")))
    return out


def marketplace_files(local_dir: str) -> List[Tuple[str, str]]:
    """Files to upload for `import-marketplace`, laid out as <marketplace>/plugins-src/… + <marketplace>/files/….
    Accepts the marketplace folder (with plugins-src/) or the plugins-src folder itself; attachments in a sibling
    files/ folder (EXAM pluginPackage "files/<name>") come along either way."""
    d = os.path.abspath(local_dir)
    if os.path.isdir(os.path.join(d, "plugins-src")):
        root = d
    elif os.path.basename(d) == "plugins-src":
        root = os.path.dirname(d)
    else:
        return [(f, f"plugins-src/{rel}") for f, rel in walk_tree(d)]
    out: List[Tuple[str, str]] = []
    for sub in ("plugins-src", "files"):
        if os.path.isdir(os.path.join(root, sub)):
            out += [(f, f"{sub}/{rel}") for f, rel in walk_tree(os.path.join(root, sub))]
    return out


def human_size(n: Optional[float]) -> str:
    if n is None:
        return "–"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def human_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "–"
    s = int(seconds)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, _ = divmod(s, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"
