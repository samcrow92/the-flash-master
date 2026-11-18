"""Business logic: users and tokens, submissions and review, published plugins + marketplace index, stats."""
from __future__ import annotations

import functools
import hashlib
import hmac
import json
import shutil
import time
from pathlib import Path

from . import __version__, packages
from .db import DB
from .releases import ReleasesMixin
from .util import (ID_RE, USER_RE, VERSION_RE, atomic_write, bad, compare_versions, conflict, forbidden,
                   json_bytes, new_token, not_found, now_iso, safe_join)

STATUSES = ("pending", "approved", "rejected", "changes_requested", "withdrawn")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Service(ReleasesMixin):
    def __init__(self, config: dict):
        self.config = config
        self.data = Path(config["dataDir"]).resolve()
        for sub in ("releases", "marketplace/plugins", "marketplace/files", "submissions", "backups"):
            (self.data / sub).mkdir(parents=True, exist_ok=True)
        self.db = DB(self.data / "flash.db")
        self.started = time.time()
        if not (self.data / "marketplace" / "index.json").exists():
            self.write_index()

    def close(self) -> None:
        self.db.close()

    # ---------- users & auth ----------
    @staticmethod
    def user_json(r) -> dict:
        return {"id": r["id"], "name": r["name"], "role": r["role"], "createdAt": r["created_at"],
                "lastSeenAt": r["last_seen_at"], "disabled": bool(r["disabled"])}

    def authenticate(self, header: str | None):
        """Return the user row for an `Authorization: Bearer|token <t>` header, or None."""
        if not header:
            return None
        scheme, _, tok = header.strip().partition(" ")
        tok = tok.strip()
        if scheme.lower() not in ("bearer", "token") or not tok.startswith("fs_") or len(tok) > 200:
            return None
        h = token_hash(tok)
        row = self.db.one("SELECT * FROM users WHERE token_hash = ?", (h,))
        if not row or not hmac.compare_digest(row["token_hash"], h) or row["disabled"]:
            return None
        seen = row["last_seen_at"]
        now = now_iso()
        if not seen or seen[:16] != now[:16]:  # at most one write per minute per user
            self.db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", (now, row["id"]))
        return row

    def create_user(self, name, role: str = "user") -> tuple[dict, str]:
        if not isinstance(name, str) or not USER_RE.match(name):
            raise bad("name must be 1-64 chars: letters, digits, . _ - (starting with a letter or digit)")
        if role not in ("user", "admin"):
            raise bad("role must be user or admin")
        token = new_token()
        with self.db.tx() as c:
            if c.execute("SELECT 1 FROM users WHERE name = ?", (name,)).fetchone():
                raise conflict(f"user {name} already exists")
            cur = c.execute("INSERT INTO users (name, role, token_hash, created_at) VALUES (?, ?, ?, ?)",
                            (name, role, token_hash(token), now_iso()))
            row = c.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        return self.user_json(row), token

    def _user(self, uid) -> dict:
        row = self.db.one("SELECT * FROM users WHERE id = ?", (uid,))
        if not row:
            raise not_found("no such user")
        return row

    def users(self) -> list[dict]:
        return [self.user_json(r) for r in self.db.all("SELECT * FROM users ORDER BY id")]

    def rotate_token(self, uid) -> str:
        self._user(uid)
        token = new_token()
        self.db.run("UPDATE users SET token_hash = ? WHERE id = ?", (token_hash(token), uid))
        return token

    def _other_active_admins(self, c, uid) -> int:
        return c.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", (uid,)).fetchone()[0]

    def update_user(self, uid, body: dict) -> dict:
        with self.db.tx() as c:
            row = self._user(uid)
            role, disabled = row["role"], bool(row["disabled"])
            if "role" in body:
                if body["role"] not in ("user", "admin"):
                    raise bad("role must be user or admin")
                role = body["role"]
            if "disabled" in body:
                if not isinstance(body["disabled"], bool):
                    raise bad("disabled must be true or false")
                disabled = body["disabled"]
            if row["role"] == "admin" and (role != "admin" or disabled) and not self._other_active_admins(c, uid):
                raise conflict("this is the last active admin")
            c.execute("UPDATE users SET role = ?, disabled = ? WHERE id = ?", (role, int(disabled), uid))
            return self.user_json(c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone())

    def delete_user(self, uid) -> None:
        with self.db.tx() as c:
            row = self._user(uid)
            if row["role"] == "admin" and not self._other_active_admins(c, uid):
                raise conflict("this is the last active admin")
            c.execute("DELETE FROM users WHERE id = ?", (uid,))

    def has_admin(self) -> bool:
        return bool(self.db.one("SELECT 1 FROM users WHERE role = 'admin'"))

    # ---------- submissions ----------
    @staticmethod
    def sub_json(r) -> dict:
        return {"id": r["id"], "pluginId": r["plugin_id"], "version": r["version"], "name": r["name"],
                "kinds": json.loads(r["kinds"]), "status": r["status"], "notes": r["notes"], "feedback": r["feedback"],
                "author": r["author"], "createdAt": r["created_at"], "reviewedAt": r["reviewed_at"], "reviewer": r["reviewer"]}

    def _sub_file(self, sid: int) -> Path:
        return self.data / "submissions" / f"{int(sid)}.json"

    def _sub_row(self, sid):
        row = self.db.one("SELECT * FROM submissions WHERE id = ?", (sid,))
        if not row:
            raise not_found("no such submission")
        return row

    def submit(self, user, body) -> tuple[int, dict]:
        if not isinstance(body, dict):
            raise bad("body must be a JSON object", 400)
        pkg = packages.validate(body.get("package"))
        notes = body.get("notes") or ""
        if not isinstance(notes, str) or len(notes) > 4000:
            raise bad("notes must be a string (max 4000 characters)")
        pid, ver = pkg["id"], pkg["version"]
        with self.db.tx() as c:
            owner = c.execute("SELECT owner_id, owner_name FROM plugins WHERE id = ?", (pid,)).fetchone()
            if owner and owner["owner_id"] != user["id"] and user["role"] != "admin":
                raise forbidden(f"plugin {pid} belongs to {owner['owner_name'] or 'another user'}")
            if c.execute("SELECT 1 FROM plugin_versions WHERE plugin_id = ? AND version = ?", (pid, ver)).fetchone():
                raise conflict(f"{pid} {ver} is already published — raise the version")
            prev = c.execute("SELECT id FROM submissions WHERE plugin_id = ? AND version = ? AND author_id = ?"
                             " AND status IN ('pending', 'changes_requested')",
                             (pid, ver, user["id"])).fetchone()
            args = (pkg["name"], json.dumps(packages.kinds(pkg)), notes)
            if prev:
                sid, status = prev["id"], 200
                # A resubmission after "changes requested" goes back to the queue; the reviewer's last feedback stays visible.
                c.execute("UPDATE submissions SET name = ?, kinds = ?, notes = ?, created_at = ?, status = 'pending' WHERE id = ?",
                          (*args, now_iso(), sid))
            else:
                status = 201
                sid = c.execute("INSERT INTO submissions (plugin_id, version, name, kinds, notes, status, author_id, author, created_at)"
                                " VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)", (pid, ver, *args, user["id"], user["name"], now_iso())).lastrowid
            atomic_write(self._sub_file(sid), packages.package_bytes(pkg))
            return status, self.sub_json(c.execute("SELECT * FROM submissions WHERE id = ?", (sid,)).fetchone())

    def submissions(self, user=None, status: str | None = None) -> list[dict]:
        sql, args = "SELECT * FROM submissions WHERE 1=1", []
        if user is not None:
            sql += " AND author_id = ?"
            args.append(user["id"])
        if status and status != "all":
            if status not in STATUSES:
                raise bad("unknown status", 400)
            sql += " AND status = ?"
            args.append(status)
        return [self.sub_json(r) for r in self.db.all(sql + " ORDER BY id DESC", tuple(args))]

    def submission_package(self, sid: int) -> dict:
        try:
            return json.loads(self._sub_file(sid).read_text(encoding="utf-8"))
        except OSError:
            raise not_found("submission package is missing") from None

    def submission(self, user, sid, admin_view: bool = False) -> dict:
        row = self._sub_row(sid)
        if not admin_view and row["author_id"] != user["id"] and user["role"] != "admin":
            raise not_found("no such submission")  # do not reveal other users' submissions
        out = {**self.sub_json(row), "package": self.submission_package(row["id"])}
        if admin_view:
            prev = self._previous_version(row["plugin_id"], row["version"])
            before = self.published_package(row["plugin_id"], prev) if prev else None
            out["diff"] = {"previousVersion": prev, "files": packages.diff(before, out["package"])}
        return out

    def withdraw(self, user, sid) -> dict:
        with self.db.tx() as c:
            row = self._sub_row(sid)
            if row["author_id"] != user["id"] and user["role"] != "admin":
                raise not_found("no such submission")
            if row["status"] not in ("pending", "changes_requested"):
                raise conflict(f"a {row['status']} submission cannot be withdrawn")
            c.execute("UPDATE submissions SET status = 'withdrawn' WHERE id = ?", (sid,))
            return self.sub_json(c.execute("SELECT * FROM submissions WHERE id = ?", (sid,)).fetchone())

    def review(self, reviewer, sid, body) -> dict:
        if not isinstance(body, dict):
            raise bad("body must be a JSON object", 400)
        decision, feedback = body.get("decision"), body.get("feedback") or ""
        if decision not in ("approve", "reject", "changes_requested"):
            raise bad("decision must be approve, reject or changes_requested")
        if not isinstance(feedback, str) or len(feedback) > 20000:
            raise bad("feedback must be a string")
        if decision != "approve" and not feedback.strip():
            raise bad("feedback is required to reject or request changes")
        with self.db.tx() as c:
            row = self._sub_row(sid)
            if row["status"] not in ("pending", "changes_requested"):
                raise conflict(f"submission is already {row['status']}")
            status = {"approve": "approved", "reject": "rejected", "changes_requested": "changes_requested"}[decision]
            if decision == "approve":
                owner = c.execute("SELECT owner_id, owner_name FROM plugins WHERE id = ?", (row["plugin_id"],)).fetchone()
                author = c.execute("SELECT role FROM users WHERE id = ?", (row["author_id"],)).fetchone()
                if owner and owner["owner_id"] != row["author_id"] and not (author and author["role"] == "admin"):
                    raise conflict(f"plugin {row['plugin_id']} now belongs to {owner['owner_name']} — reject this submission")
                pkg = self.submission_package(sid)
                self.publish_package(pkg, author_id=row["author_id"], author=row["author"], submission_id=sid)
            c.execute("UPDATE submissions SET status = ?, feedback = ?, reviewed_at = ?, reviewer = ? WHERE id = ?",
                      (status, feedback.strip() or None, now_iso(), reviewer["name"], sid))
            return self.sub_json(c.execute("SELECT * FROM submissions WHERE id = ?", (sid,)).fetchone())

    # ---------- published plugins ----------
    def _pkg_path(self, pid: str, ver: str) -> Path:
        if not ID_RE.match(pid) or not VERSION_RE.match(ver):
            raise not_found()
        return safe_join(self.data / "marketplace" / "plugins", f"{pid}-{ver}.json")

    def published_package(self, pid: str, ver: str) -> dict | None:
        try:
            return json.loads(self._pkg_path(pid, ver).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _previous_version(self, pid: str, ver: str) -> str | None:
        vers = [r[0] for r in self.db.all("SELECT version FROM plugin_versions WHERE plugin_id = ?", (pid,)) if r[0] != ver]
        older = [v for v in vers if compare_versions(v, ver) < 0] or vers
        return max_version(older)

    def publish_package(self, pkg: dict, author_id, author: str, submission_id=None) -> dict:
        """Write the package file, record the version (and the owner on first publish), regenerate the index."""
        pid, ver = pkg["id"], pkg["version"]
        body = packages.package_bytes(pkg)
        sha = hashlib.sha256(body).hexdigest()
        with self.db.tx() as c:
            if c.execute("SELECT 1 FROM plugin_versions WHERE plugin_id = ? AND version = ?", (pid, ver)).fetchone():
                raise conflict(f"{pid} {ver} is already published")
            if not c.execute("SELECT 1 FROM plugins WHERE id = ?", (pid,)).fetchone():
                c.execute("INSERT INTO plugins (id, owner_id, owner_name, created_at) VALUES (?, ?, ?, ?)", (pid, author_id, author, now_iso()))
            c.execute("INSERT INTO plugin_versions (plugin_id, version, name, description, team, kinds, tags, sha256, author, submission_id, published_at)"
                      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      (pid, ver, pkg["name"], pkg.get("description", ""), pkg.get("team", ""), json.dumps(packages.kinds(pkg)),
                       json.dumps(pkg.get("tags", [])), sha, author, submission_id, now_iso()))
            atomic_write(self._pkg_path(pid, ver), body)
            self.write_index()
        return {"id": pid, "version": ver, "sha256": sha}

    def plugins(self) -> list[dict]:
        rows = self.db.all("SELECT p.id, p.owner_name, v.version, v.name, v.published_at, v.sha256 FROM plugins p"
                           " LEFT JOIN plugin_versions v ON v.plugin_id = p.id ORDER BY p.id")
        out: dict[str, dict] = {}
        for r in rows:
            p = out.setdefault(r["id"], {"id": r["id"], "name": r["id"], "owner": r["owner_name"], "versions": [], "latest": None})
            if r["version"]:
                p["versions"].append({"version": r["version"], "publishedAt": r["published_at"], "sha256": r["sha256"]})
                if p["latest"] is None or compare_versions(r["version"], p["latest"]) > 0:
                    p["latest"], p["name"] = r["version"], r["name"]
        for p in out.values():
            p["versions"].sort(key=_vkey, reverse=True)
        return list(out.values())

    def unpublish(self, pid: str, ver: str | None = None) -> None:
        with self.db.tx() as c:
            if not c.execute("SELECT 1 FROM plugins WHERE id = ?", (pid,)).fetchone():
                raise not_found("no such plugin")
            vers = [r[0] for r in c.execute("SELECT version FROM plugin_versions WHERE plugin_id = ?", (pid,))]
            if ver is not None:
                if ver not in vers:
                    raise not_found("no such version")
                vers = [ver]
                c.execute("DELETE FROM plugin_versions WHERE plugin_id = ? AND version = ?", (pid, ver))
            else:
                c.execute("DELETE FROM plugin_versions WHERE plugin_id = ?", (pid,))
                c.execute("DELETE FROM plugins WHERE id = ?", (pid,))  # frees the id (ownership) too
            for v in vers:
                try:
                    self._pkg_path(pid, v).unlink()
                except FileNotFoundError:
                    pass
            self.write_index()

    def index(self) -> dict:
        rows = self.db.all("SELECT * FROM plugin_versions")
        newest: dict[str, object] = {}
        for r in rows:
            cur = newest.get(r["plugin_id"])
            if cur is None or compare_versions(r["version"], cur["version"]) > 0:
                newest[r["plugin_id"]] = r
        plugins = [{"id": r["plugin_id"], "name": r["name"], "version": r["version"], "description": r["description"], "team": r["team"],
                    "kinds": json.loads(r["kinds"]), "tags": json.loads(r["tags"]), "package": f"plugins/{r['plugin_id']}-{r['version']}.json",
                    "sha256": r["sha256"], "updated": r["published_at"][:10], "author": r["author"] or ""}
                   for _, r in sorted(newest.items())]
        return {"name": self.config.get("name", "Flash Server"), "description": self.config.get("description", ""), "plugins": plugins}

    def write_index(self) -> None:
        with self.db.lock:
            atomic_write(self.data / "marketplace" / "index.json", json_bytes(self.index(), pretty=True))

    def rebuild_index(self) -> dict:
        """Re-hash every package file, drop versions whose file is gone, rewrite index.json."""
        fixed, missing = [], []
        with self.db.tx() as c:
            for r in c.execute("SELECT plugin_id, version, sha256 FROM plugin_versions").fetchall():
                p = self._pkg_path(r[0], r[1])
                if not p.is_file():
                    missing.append(f"{r[0]}@{r[1]}")
                    c.execute("DELETE FROM plugin_versions WHERE plugin_id = ? AND version = ?", (r[0], r[1]))
                    continue
                sha = hashlib.sha256(p.read_bytes()).hexdigest()
                if sha != r[2]:
                    fixed.append(f"{r[0]}@{r[1]}")
                    c.execute("UPDATE plugin_versions SET sha256 = ? WHERE plugin_id = ? AND version = ?", (sha, r[0], r[1]))
            self.write_index()
        return {"plugins": len(self.index()["plugins"]), "rehashed": fixed, "missing": missing}

    def import_marketplace(self, folder: Path, owner=None) -> dict:
        """Publish every plugins-src/<id>/ as approved (skips versions already published)."""
        folder = Path(folder).resolve()
        src = folder / "plugins-src" if (folder / "plugins-src").is_dir() else folder
        root = src.parent
        if not src.is_dir():
            raise bad(f"{src} is not a folder")
        if owner is None:
            owner = self.db.one("SELECT * FROM users WHERE role = 'admin' ORDER BY id")
        imported, skipped, errors = [], [], []
        for d in sorted(src.iterdir(), key=lambda x: x.name):
            if not (d / "plugin.json").is_file():
                continue
            try:
                pkg, attachments = packages.read_plugin_src(d, root)
            except ValueError as e:
                errors.append({"id": d.name, "error": str(e)})
                continue
            if self.db.one("SELECT 1 FROM plugin_versions WHERE plugin_id = ? AND version = ?", (pkg["id"], pkg["version"])):
                skipped.append(f"{pkg['id']}@{pkg['version']}")
                continue
            for a in attachments:
                shutil.copyfile(a, safe_join(self.data / "marketplace" / "files", a.name))
            author_id, author = (owner["id"], owner["name"]) if owner else (None, "import")
            with self.db.tx() as c:
                sid = c.execute("INSERT INTO submissions (plugin_id, version, name, kinds, notes, status, author_id, author, created_at, reviewed_at, reviewer)"
                                " VALUES (?, ?, ?, ?, 'imported from plugins-src', 'approved', ?, ?, ?, ?, ?)",
                                (pkg["id"], pkg["version"], pkg["name"], json.dumps(packages.kinds(pkg)), author_id, author, now_iso(), now_iso(), author)).lastrowid
                atomic_write(self._sub_file(sid), packages.package_bytes(pkg))
                self.publish_package(pkg, author_id, author, sid)
            imported.append(f"{pkg['id']}@{pkg['version']}")
        return {"imported": imported, "skipped": skipped, "errors": errors}

    # ---------- stats ----------
    def stats(self) -> dict:
        ch = {r["name"]: r["version"] for r in self.db.all("SELECT * FROM channels")}
        return {"users": self.db.one("SELECT COUNT(*) FROM users")[0], "plugins": self.db.one("SELECT COUNT(*) FROM plugins")[0],
                "pendingSubmissions": self.db.one("SELECT COUNT(*) FROM submissions WHERE status = 'pending'")[0],
                "releases": {"stable": ch.get("stable"), "beta": ch.get("beta")}, "diskFreeBytes": shutil.disk_usage(self.data).free,
                "dataDir": str(self.data), "uptimeSeconds": int(time.time() - self.started)}

    def health(self) -> dict:
        return {"ok": True, "name": self.config.get("name", "Flash Server"), "version": __version__, "publicRead": bool(self.config.get("publicRead"))}


_vkey = functools.cmp_to_key(lambda a, b: compare_versions(a["version"], b["version"]))


def max_version(vers: list[str]) -> str | None:
    best = None
    for v in vers:
        if best is None or compare_versions(v, best) > 0:
            best = v
    return best

