#!/usr/bin/env python3
"""Publish a built release folder to a Flash server (standard library only).

    py -3 flash-server/tools/publish_release.py --dir release --channel stable --notes "…"

Server and admin token come from --server/--token or FLASH_SERVER_URL / FLASH_SERVER_TOKEN.
Uploads every file of this version (the .exe files, latest.json, SHA256SUMS.txt) with a SHA-256 check, then publishes the
release on the channel. `scripts/release.py` can call `publish(...)` after its build step (see flash-server/API.md, Releases).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CHUNK = 1 << 20


class PublishError(Exception):
    pass


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
    return h.hexdigest()


def release_files(folder: Path, version: str) -> list[Path]:
    """The files that belong to `version` in an electron-builder output folder."""
    out = [p for p in sorted(folder.iterdir()) if p.is_file() and (
        (p.suffix.lower() == ".exe" and version in p.name) or p.name in ("latest.json", "SHA256SUMS.txt"))]
    if not any(p.suffix.lower() == ".exe" for p in out):
        raise PublishError(f"No {version} .exe files in {folder} — build the release first")
    return out


def _request(method: str, url: str, token: str, body=None, length: int | None = None, ctype="application/json") -> dict:
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": ctype, "Accept": "application/json",
        "User-Agent": "TheFlashMaster-release"})
    if length is not None:
        req.add_header("Content-Length", str(length))
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("error", "")
        except Exception:  # noqa: BLE001 - best effort detail
            detail = ""
        hint = {401: " — the admin token is wrong", 403: " — the token is not an admin token",
                409: " — that version already exists or is in use", 413: " — file too large for the server (or nginx client_max_body_size)"}.get(e.code, "")
        raise PublishError(f"HTTP {e.code} for {method} {url}: {detail or e.reason}{hint}") from None
    except urllib.error.URLError as e:
        raise PublishError(f"Cannot reach {url}: {e.reason} (check the server URL, VPN or HTTPS_PROXY)") from None


class _Progress:
    """File-like reader that reports upload progress."""

    def __init__(self, path: Path, size: int, report):
        self.f, self.size, self.done, self.report = path.open("rb"), size, 0, report

    def read(self, n: int = CHUNK) -> bytes:
        b = self.f.read(min(n, CHUNK) if n and n > 0 else CHUNK)
        self.done += len(b)
        self.report(self.done, self.size)
        if not b:
            self.f.close()
        return b


def _base(server: str) -> str:
    base = server.strip().rstrip("/")
    return base if re.match(r"^https?://", base) else f"http://{base}"


def current_versions(server: str, token: str) -> dict:
    """{"stable": "0.4.0" | None, "beta": …} — also proves the URL and the admin token work."""
    cur = _request("GET", f"{_base(server)}/api/v1/admin/releases", token).get("current") or {}
    return {"stable": cur.get("stable"), "beta": cur.get("beta")}


def publish(server: str, token: str, folder: Path, version: str, channel: str = "stable", notes: str = "",
            log=print) -> dict:
    if channel not in ("stable", "beta"):
        raise PublishError("channel must be stable or beta")
    base = _base(server)
    v = urllib.parse.quote(version, safe="")
    for p in release_files(folder, version):
        size, sha = p.stat().st_size, sha256_file(p)
        url = f"{base}/api/v1/admin/releases/{v}/files/{urllib.parse.quote(p.name)}?sha256={sha}"

        def report(done: int, total: int, name=p.name) -> None:
            pct = 100 if not total else done * 100 // total
            sys.stderr.write(f"\r  {name}: {pct:3d}% of {total / 1e6:.1f} MB")
            if done >= total:
                sys.stderr.write("\n")

        _request("PUT", url, token, body=_Progress(p, size, report), length=size, ctype="application/octet-stream")
    rel = _request("POST", f"{base}/api/v1/admin/releases/{v}/publish", token,
                   body=json.dumps({"channel": channel, "notes": notes}).encode())
    log(f"Published {version} on {channel}: {base}/updates/{channel}/latest.json")
    return rel


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--server", default=os.environ.get("FLASH_SERVER_URL", ""))
    ap.add_argument("--token", default=os.environ.get("FLASH_SERVER_TOKEN", ""))
    ap.add_argument("--dir", default="release")
    ap.add_argument("--version", help="defaults to package.json's version")
    ap.add_argument("--channel", default="stable", choices=["stable", "beta"])
    ap.add_argument("--notes", default="")
    a = ap.parse_args(argv)
    if not a.server or not a.token:
        print("Set --server and --token (or FLASH_SERVER_URL / FLASH_SERVER_TOKEN). The admin token is in the admin GUI → Connections.", file=sys.stderr)
        return 2
    version = a.version or json.loads(Path("package.json").read_text(encoding="utf-8"))["version"]
    try:
        publish(a.server, a.token, Path(a.dir), version, a.channel, a.notes)
    except PublishError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
