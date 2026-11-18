"""App releases: streamed uploads, publish (latest.json + channel pointer), promote, guarded delete, feed lookups."""
from __future__ import annotations

import functools
import hashlib
import os
import re
import secrets
import shutil
from pathlib import Path

from .util import NAME_RE, VERSION_RE, ApiError, atomic_write, bad, compare_versions, conflict, json_bytes, not_found, now_iso, replace, safe_join

MAX_UPLOAD = 2 * 1024 ** 3
CHANNELS = ("stable", "beta")
CHUNK = 1 << 20


def check_version(v: str) -> str:
    if not VERSION_RE.match(v or ""):
        raise not_found("no such release")
    return v


def check_name(n: str) -> str:
    if not NAME_RE.match(n or "") or n.startswith("."):
        raise bad("file name must match ^[\\w.-]+$", 400)
    return n


class ReleasesMixin:
    db: object
    data: Path

    def _rel_dir(self, version: str) -> Path:
        return safe_join(self.data / "releases", check_version(version))

    def _release(self, c, version: str):
        return c.execute("SELECT * FROM releases WHERE version = ?", (version,)).fetchone()

    def channels(self) -> dict:
        ch = {r["name"]: r["version"] for r in self.db.all("SELECT * FROM channels")}
        return {c: ch.get(c) for c in CHANNELS}

    def release_json(self, r) -> dict:
        files = [{"kind": file_kind(f["name"], r["version"]), "name": f["name"], "sha256": f["sha256"], "size": f["size"]}
                 for f in self.db.all("SELECT * FROM release_files WHERE version = ? ORDER BY name", (r["version"],))]
        return {"version": r["version"], "channel": r["channel"], "date": r["date"], "notes": r["notes"], "files": files, "published": bool(r["published"])}

    def releases(self) -> dict:
        rows = self.db.all("SELECT * FROM releases")
        rows = sorted(rows, key=lambda r: _cmp_key(r["version"]), reverse=True)
        return {"releases": [self.release_json(r) for r in rows], "current": self.channels()}

    def upload_release_file(self, version: str, name: str, stream, length: int, expected_sha: str | None) -> dict:
        """Stream `length` bytes from `stream` into releases/<version>/<name>, hashing on the way."""
        check_version(version)
        check_name(name)
        if expected_sha is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha):
            raise bad("sha256 must be 64 hex characters", 400)
        if length > MAX_UPLOAD:
            raise ApiError(413, "too_large", "release files are limited to 2 GB")
        folder = self._rel_dir(version)
        folder.mkdir(parents=True, exist_ok=True)
        target = safe_join(folder, name)
        part = folder / f".{name}.{secrets.token_hex(4)}.part"
        h, got = hashlib.sha256(), 0
        try:
            with open(part, "wb") as f:
                while got < length:
                    b = stream.read(min(CHUNK, length - got))
                    if not b:
                        raise bad("upload ended early", 400)
                    h.update(b)
                    f.write(b)
                    got += len(b)
                f.flush()
                os.fsync(f.fileno())
            sha = h.hexdigest()
            if expected_sha and sha != expected_sha.lower():
                raise bad(f"sha256 mismatch: got {sha}")
            with self.db.tx() as c:
                if not self._release(c, version):
                    c.execute("INSERT INTO releases (version, created_at) VALUES (?, ?)", (version, now_iso()))
                replace(part, target)
                c.execute("INSERT OR REPLACE INTO release_files (version, name, sha256, size, uploaded_at) VALUES (?, ?, ?, ?, ?)",
                          (version, name, sha, got, now_iso()))
                rel = self._release(c, version)
                if rel["published"] and name != "latest.json":
                    self._write_manifest(c, rel, rel["notes"])
        finally:
            if part.exists():
                part.unlink()
        return {"name": name, "size": got, "sha256": sha}

    def _write_manifest(self, c, rel, notes: str) -> None:
        v = rel["version"]
        files = [{"kind": file_kind(f["name"], v), "name": f["name"], "sha256": f["sha256"], "size": f["size"]}
                 for f in c.execute("SELECT * FROM release_files WHERE version = ? ORDER BY name", (v,)).fetchall()
                 if f["name"].lower().endswith(".exe") and v in f["name"]]
        if not files:
            raise bad(f"release {v} needs at least one .exe whose name contains {v}")
        date = now_iso()
        manifest = {"version": v, "date": date, "notes": notes, "files": files}
        body = json_bytes(manifest, pretty=True)
        atomic_write(safe_join(self._rel_dir(v), "latest.json"), body)
        c.execute("INSERT OR REPLACE INTO release_files (version, name, sha256, size, uploaded_at) VALUES (?, 'latest.json', ?, ?, ?)",
                  (v, hashlib.sha256(body).hexdigest(), len(body), date))
        c.execute("UPDATE releases SET date = ?, notes = ? WHERE version = ?", (date, notes, v))

    def publish_release(self, version: str, body) -> dict:
        check_version(version)
        body = body if isinstance(body, dict) else {}
        channel = body.get("channel", "stable")
        if channel not in CHANNELS:
            raise bad("channel must be stable or beta")
        with self.db.tx() as c:
            rel = self._release(c, version)
            if not rel:
                raise not_found("no such release — upload its files first")
            notes = body.get("notes")
            notes = rel["notes"] if notes is None else notes
            if not isinstance(notes, str) or len(notes) > 20000:
                raise bad("notes must be a string")
            self._write_manifest(c, rel, notes)
            c.execute("UPDATE releases SET published = 1, channel = ? WHERE version = ?", (channel, version))
            c.execute("INSERT OR REPLACE INTO channels (name, version) VALUES (?, ?)", (channel, version))
            return self.release_json(self._release(c, version))

    def promote_release(self, version: str, body) -> dict:
        check_version(version)
        channel = (body or {}).get("channel", "stable") if isinstance(body, dict) else "stable"
        if channel not in CHANNELS:
            raise bad("channel must be stable or beta")
        with self.db.tx() as c:
            rel = self._release(c, version)
            if not rel:
                raise not_found("no such release")
            if not rel["published"]:
                raise conflict("publish the release first")
            c.execute("UPDATE releases SET channel = ? WHERE version = ?", (channel, version))
            c.execute("INSERT OR REPLACE INTO channels (name, version) VALUES (?, ?)", (channel, version))
            return self.release_json(self._release(c, version))

    def delete_release(self, version: str) -> None:
        check_version(version)
        with self.db.tx() as c:
            if not self._release(c, version):
                raise not_found("no such release")
            using = [r["name"] for r in c.execute("SELECT name FROM channels WHERE version = ?", (version,))]
            if using:
                raise conflict(f"{', '.join(using)} points at {version} — promote another release first")
            c.execute("DELETE FROM release_files WHERE version = ?", (version,))
            c.execute("DELETE FROM releases WHERE version = ?", (version,))
            shutil.rmtree(self._rel_dir(version), ignore_errors=True)

    # ---------- feed ----------
    def channel_version(self, channel: str) -> str | None:
        """stable -> its pointer; beta -> the newer of the stable and beta pointers."""
        if channel not in CHANNELS:
            raise not_found()
        ch = self.channels()
        if channel == "stable":
            return ch["stable"]
        cands = [v for v in (ch["stable"], ch["beta"]) if v]
        if not cands:
            return None
        return max(cands, key=_cmp_key)

    def feed_manifest(self, channel: str) -> Path:
        v = self.channel_version(channel)
        if not v:
            raise not_found(f"nothing published on {channel} yet")
        p = safe_join(self._rel_dir(v), "latest.json")
        if not p.is_file():
            raise not_found()
        return p

    def feed_file(self, channel: str, name: str) -> Path:
        if not NAME_RE.match(name or "") or name.startswith("."):
            raise not_found()
        v = self.channel_version(channel)
        cands = ([v] if v else []) + [r["version"] for r in self.db.all(
            "SELECT r.version FROM releases r JOIN release_files f ON f.version = r.version WHERE r.published = 1 AND f.name = ?", (name,))]
        for ver in cands:
            if self.db.one("SELECT 1 FROM release_files WHERE version = ? AND name = ?", (ver, name)):
                p = safe_join(self._rel_dir(ver), name)
                if p.is_file():
                    return p
        raise not_found()

    def publish_release_dir(self, folder: Path, version: str, channel: str, notes: str | None) -> dict:
        """CLI: copy every file of a local folder into the release, then publish it."""
        folder = Path(folder)
        if not folder.is_dir():
            raise bad(f"{folder} is not a folder")
        for p in sorted(folder.iterdir(), key=lambda x: x.name):
            if p.is_file() and NAME_RE.match(p.name) and not p.name.startswith("."):
                with open(p, "rb") as f:
                    self.upload_release_file(version, p.name, f, p.stat().st_size, None)
        return self.publish_release(version, {"channel": channel, "notes": notes})


def file_kind(name: str, version: str) -> str:
    if name.lower().endswith(".exe"):
        return "portable" if "portable" in name.lower() else "setup"
    return "other"


_cmp_key = functools.cmp_to_key(compare_versions)
