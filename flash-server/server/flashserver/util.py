"""Small shared helpers: errors, time, atomic writes, safe paths, version compare."""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
VERSION_RE = re.compile(r"^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$")
NAME_RE = re.compile(r"^[\w.-]{1,200}$", re.ASCII)  # release / attachment file names
USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def bad(msg: str, status: int = 422) -> ApiError:
    return ApiError(status, "invalid", msg)


def not_found(msg: str = "not found") -> ApiError:
    return ApiError(404, "not_found", msg)


def conflict(msg: str) -> ApiError:
    return ApiError(409, "conflict", msg)


def forbidden(msg: str = "forbidden") -> ApiError:
    return ApiError(403, "forbidden", msg)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def json_bytes(obj, pretty: bool = False) -> bytes:
    return json.dumps(obj, ensure_ascii=False, indent=2 if pretty else None).encode("utf-8")


def atomic_write(path: Path, data: bytes) -> None:
    """Write via a temp file in the same folder, then os.replace (atomic on POSIX and NTFS)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{secrets.token_hex(4)}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    replace(tmp, path)


def replace(src: Path, dst: Path) -> None:
    # Windows refuses to replace a file another thread has open for a moment; retry briefly.
    for i in range(20):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == 19:
                raise
            time.sleep(0.05)


def safe_join(root: Path, *parts: str) -> Path:
    """Join and make sure the result stays inside root (names are regex-checked before; this is the second fence)."""
    for p in parts:
        if not p or p in (".", "..") or "/" in p or "\\" in p or "\x00" in p or ":" in p:
            raise not_found()
    full = root.joinpath(*parts).resolve()
    base = root.resolve()
    if full != base and base not in full.parents:
        raise not_found()
    return full


def compare_versions(a: str, b: str) -> int:
    """Port of src/main/marketplace.ts compareVersions: numeric parts, pre-release < release."""
    ma, _, pa = a.strip().partition("-")
    mb, _, pb = b.strip().partition("-")
    def nums(s: str) -> list[int]:
        out = []
        for x in s.split("."):
            try:
                out.append(int(x))
            except ValueError:
                out.append(0)
        return out
    na, nb = nums(ma), nums(mb)
    for i in range(max(len(na), len(nb))):
        d = (na[i] if i < len(na) else 0) - (nb[i] if i < len(nb) else 0)
        if d:
            return 1 if d > 0 else -1
    ha, hb = "-" in a.strip(), "-" in b.strip()
    if ha == hb and pa == pb:
        return 0
    if not ha:
        return 1
    if not hb:
        return -1
    return -1 if pa < pb else 1


def new_token() -> str:
    return "fs_" + secrets.token_urlsafe(30)  # 40 url-safe chars
