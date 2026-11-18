"""Fake backend for screenshots and UI development: python -m flashadmin --demo."""
from __future__ import annotations

import copy
import time
from typing import Optional

from . import remote
from .profiles import Profile

AGENT_V1 = """---
name: hil-tester
description: Runs HIL test campaigns on the body controller bench.
tools: [winidea, vector-autosar]
---
You are a HIL test engineer for the Body ECU.
1. Flash the build with winIDEA.
2. Run the smoke campaign.
3. Report failures with the CAN trace.
"""
AGENT_V2 = """---
name: hil-tester
description: Runs HIL test campaigns on the body controller bench, incl. door module.
tools: [winidea, vector-autosar, exam]
---
You are a HIL test engineer for the Body ECU.
1. Flash the build with winIDEA and verify the checksum.
2. Run the smoke campaign, then the door-module regression.
3. Report failures with the CAN trace and the EXAM verdict link.
Never power-cycle the bench while flashing.
"""
WORKFLOW = """---
command: hil-campaign
description: Full nightly HIL campaign
---
Run /flash, then the smoke and regression suites. Summarise results in a table.
"""
SCRIPT = """param([string]$Build)
Write-Host "Flashing $Build"
& winidea.exe /flash $Build
"""

PKG_V2 = {
    "id": "body-sw-test-pack", "name": "Body SW test pack", "version": "1.2.0", "team": "Body",
    "description": "HIL agents, the nightly campaign workflow and the flash script for the body bench.",
    "tags": ["hil", "body"],
    "agents": [{"file": "hil-tester.md", "content": AGENT_V2}],
    "workflows": [{"file": "hil-campaign.md", "content": WORKFLOW}],
    "scripts": [{"file": "flash.ps1", "content": SCRIPT}],
    "instructions": "Use the bench in room B2 only. Book it in the team calendar first.",
}


def _iso(minutes_ago: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - minutes_ago * 60))


SUBMISSIONS = [
    {"id": 14, "pluginId": "body-sw-test-pack", "version": "1.2.0", "name": "Body SW test pack",
     "kinds": ["agent", "workflow", "script", "instructions"], "status": "pending",
     "notes": "Adds the door-module regression and EXAM links. Tested on bench B2 for a week.",
     "feedback": None, "author": "ana", "createdAt": _iso(42), "reviewedAt": None, "reviewer": None},
    {"id": 13, "pluginId": "unslop", "version": "0.3.0", "name": "Unslop skill", "kinds": ["skill"],
     "status": "pending", "notes": "Tighter rules for commit messages.", "feedback": None, "author": "jonas",
     "createdAt": _iso(180), "reviewedAt": None, "reviewer": None},
    {"id": 12, "pluginId": "can-tools", "version": "2.0.0", "name": "CAN tools MCP", "kinds": ["mcp"],
     "status": "changes_requested", "notes": "New DBC parser.", "feedback": "Please pin the python version.",
     "author": "lee", "createdAt": _iso(2000), "reviewedAt": _iso(1900), "reviewer": "mari"},
    {"id": 11, "pluginId": "exam-preset", "version": "1.0.1", "name": "EXAM preset", "kinds": ["exam"],
     "status": "approved", "notes": "Fix REST port.", "feedback": "Thanks!", "author": "ana",
     "createdAt": _iso(5000), "reviewedAt": _iso(4900), "reviewer": "mari"},
]

PLUGINS = [
    {"id": "body-sw-test-pack", "name": "Body SW test pack", "owner": "ana", "latest": "1.1.0",
     "versions": [{"version": "1.1.0", "publishedAt": _iso(20000), "sha256": "9f2c41aa07be"},
                  {"version": "1.0.0", "publishedAt": _iso(60000), "sha256": "11ab0c9e3d4f"}]},
    {"id": "exam-preset", "name": "EXAM preset", "owner": "ana", "latest": "1.0.1",
     "versions": [{"version": "1.0.1", "publishedAt": _iso(4900), "sha256": "77c0de21f9aa"},
                  {"version": "1.0.0", "publishedAt": _iso(30000), "sha256": "3e4f5a6b7c8d"}]},
    {"id": "unslop", "name": "Unslop skill", "owner": "jonas", "latest": "0.2.0",
     "versions": [{"version": "0.2.0", "publishedAt": _iso(15000), "sha256": "a1b2c3d4e5f6"}]},
    {"id": "autosar-reviewer", "name": "AUTOSAR reviewer", "owner": "mari", "latest": "3.4.0",
     "versions": [{"version": "3.4.0", "publishedAt": _iso(8000), "sha256": "c0ffee123456"},
                  {"version": "3.3.2", "publishedAt": _iso(26000), "sha256": "deadbeef0001"}]},
]

USERS = [
    {"id": 1, "name": "mari", "role": "admin", "createdAt": _iso(90000), "lastSeenAt": _iso(1), "disabled": False},
    {"id": 2, "name": "ana", "role": "user", "createdAt": _iso(80000), "lastSeenAt": _iso(42), "disabled": False},
    {"id": 3, "name": "jonas", "role": "user", "createdAt": _iso(70000), "lastSeenAt": _iso(180), "disabled": False},
    {"id": 4, "name": "lee", "role": "user", "createdAt": _iso(50000), "lastSeenAt": _iso(3000), "disabled": False},
    {"id": 5, "name": "build-bot", "role": "admin", "createdAt": _iso(40000), "lastSeenAt": _iso(600), "disabled": False},
    {"id": 6, "name": "intern-2025", "role": "user", "createdAt": _iso(300000), "lastSeenAt": _iso(200000), "disabled": True},
]


def _files(v: str, beta: bool = False):
    return [{"kind": "setup", "name": f"TheFlashMaster-{v}-x64-setup.exe", "sha256": "ab" * 32, "size": 98_400_000},
            {"kind": "portable", "name": f"TheFlashMaster-{v}-x64-portable.exe", "sha256": "cd" * 32, "size": 97_100_000}]


RELEASES = {
    "releases": [
        {"version": "0.6.0-beta.2", "channel": "beta", "date": _iso(300), "published": True,
         "notes": "Marketplace submissions, server settings.", "files": _files("0.6.0-beta.2")},
        {"version": "0.5.1", "channel": "stable", "date": _iso(9000), "published": True,
         "notes": "Fixes for the updater and Duo harness.", "files": _files("0.5.1")},
        {"version": "0.5.0", "channel": "stable", "date": _iso(30000), "published": True,
         "notes": "Jazz mode, RCA diagrams.", "files": _files("0.5.0")},
        {"version": "0.6.0-beta.3", "channel": "", "date": _iso(20), "published": False,
         "notes": "", "files": _files("0.6.0-beta.3")[:1]},
    ],
    "current": {"stable": "0.5.1", "beta": "0.6.0-beta.2"},
}


class FakeApi:
    """Same surface as api.ApiClient, in memory."""

    base_url = "http://127.0.0.1:52811"
    token = "fs_demo"

    def __init__(self):
        self._subs = copy.deepcopy(SUBMISSIONS)
        self._users = copy.deepcopy(USERS)
        self._plugins = copy.deepcopy(PLUGINS)
        self._rel = copy.deepcopy(RELEASES)

    def health(self):
        return {"ok": True, "name": "Body team flash server", "version": "1.0.0", "publicRead": False}

    def me(self):
        return {"id": 1, "name": "mari", "role": "admin"}

    def stats(self):
        return {"users": len(self._users), "plugins": len(self._plugins),
                "pendingSubmissions": sum(1 for s in self._subs if s["status"] == "pending"),
                "releases": dict(self._rel["current"]), "diskFreeBytes": 182_400_000_000,
                "dataDir": "/var/lib/flash-server", "uptimeSeconds": 3 * 86400 + 5 * 3600}

    def submissions(self, status="pending"):
        if status in ("all", "", None):
            return list(self._subs)
        return [s for s in self._subs if s["status"] == status]

    def submission(self, sid):
        s = dict(next(x for x in self._subs if x["id"] == sid))
        if s["pluginId"] == "body-sw-test-pack":
            s["package"] = PKG_V2
            s["diff"] = {"previousVersion": "1.1.0", "files": [
                {"path": "agents/hil-tester.md", "change": "modified", "before": AGENT_V1, "after": AGENT_V2},
                {"path": "scripts/flash.ps1", "change": "added", "before": "", "after": SCRIPT},
                {"path": "instructions.md", "change": "modified", "before": "Use the bench in room B2 only.",
                 "after": PKG_V2["instructions"]},
                {"path": "workflows/old-smoke.md", "change": "removed", "before": "Run the smoke suite.\n", "after": ""},
            ]}
        else:
            s["package"] = {"id": s["pluginId"], "name": s["name"], "version": s["version"],
                            "skills": [{"file": "unslop.md", "content": "---\nname: unslop\n---\nWrite plainly."}]}
            s["diff"] = {"previousVersion": None, "files": []}
        return s

    def review(self, sid, decision, feedback=""):
        s = next(x for x in self._subs if x["id"] == sid)
        s["status"] = {"approve": "approved", "reject": "rejected"}.get(decision, decision)
        s["feedback"], s["reviewer"], s["reviewedAt"] = feedback or None, "mari", _iso(0)
        return s

    def plugins(self):
        return self._plugins

    def unpublish(self, plugin_id, version=None):
        return {"ok": True}

    def users(self):
        return self._users

    def create_user(self, name, role="user"):
        u = {"id": max(x["id"] for x in self._users) + 1, "name": name, "role": role, "createdAt": _iso(0),
             "lastSeenAt": None, "disabled": False}
        self._users.append(u)
        return {"user": u, "token": "fs_Q3v9xK2mL7pR4tW8yZ1aB5cD6eF0gH2jN4sU6wX8"}

    def rotate_token(self, uid):
        return "fs_R0tAt3dT0k3nAbCdEfGhIjKlMnOpQrStUvWxYz12"

    def update_user(self, uid, **fields):
        u = next(x for x in self._users if x["id"] == uid)
        u.update(fields)
        return u

    def delete_user(self, uid):
        self._users = [u for u in self._users if u["id"] != uid]
        return {"ok": True}

    def releases(self):
        return self._rel

    def publish_release(self, version, channel, notes=""):
        return {}

    def promote_release(self, version, channel="stable"):
        return {}

    def delete_release(self, version):
        return {"ok": True}

    def upload_release_file(self, *a, **k):
        return {}


DEMO_SHELL = (
    b"\x1b[1;32mmari@flashbox\x1b[0m:\x1b[1;34m~\x1b[0m$ systemctl status flash-server --no-pager\r\n"
    b"\x1b[1;32m\xe2\x97\x8f\x1b[0m flash-server.service - Flash Server\r\n"
    b"     Loaded: loaded (/etc/systemd/system/flash-server.service; \x1b[1;32menabled\x1b[0m)\r\n"
    b"     Active: \x1b[1;32mactive (running)\x1b[0m since Mon 2026-11-16 06:00:12 UTC; 2 days ago\r\n"
    b"   Main PID: 812 (python3)\r\n"
    b"     Memory: 38.2M\r\n"
    b"     CGroup: /system.slice/flash-server.service\r\n"
    b"             \xe2\x94\x94\xe2\x94\x80812 python3 -m flashserver serve --config /etc/flash-server/config.json\r\n\r\n"
    b"\x1b[1;32mmari@flashbox\x1b[0m:\x1b[1;34m~\x1b[0m$ ls -la /var/lib/flash-server\r\n"
    b"total 2140\r\n"
    b"drwxr-x--- 6 flash flash    4096 Nov 18 06:00 \x1b[1;34m.\x1b[0m\r\n"
    b"drwxr-xr-x 3 root  root     4096 Nov 10 09:12 \x1b[1;34m..\x1b[0m\r\n"
    b"drwxr-x--- 2 flash flash    4096 Nov 17 22:00 \x1b[1;34mbackups\x1b[0m\r\n"
    b"-rw-r----- 1 flash flash 2154496 Nov 18 06:00 flash.db\r\n"
    b"drwxr-x--- 4 flash flash    4096 Nov 12 14:30 \x1b[1;34mmarketplace\x1b[0m\r\n"
    b"drwxr-x--- 5 flash flash    4096 Nov 18 05:40 \x1b[1;34mreleases\x1b[0m\r\n"
    b"drwxr-x--- 2 flash flash    4096 Nov 18 05:58 \x1b[1;34msubmissions\x1b[0m\r\n\r\n"
    b"\x1b[1;32mmari@flashbox\x1b[0m:\x1b[1;34m~\x1b[0m$ df -h /var/lib\r\n"
    b"Filesystem      Size  Used Avail Use% Mounted on\r\n"
    b"/dev/sda2       234G   52G  170G  \x1b[33m24%\x1b[0m /\r\n\r\n"
    b"\x1b[1;32mmari@flashbox\x1b[0m:\x1b[1;34m~\x1b[0m$ tail -n 3 /var/log/syslog | grep -i error\r\n"
    b"\x1b[31mNov 18 05:12:01 flashbox CRON[2211]: (root) error: backup target missing, retrying\x1b[0m\r\n\r\n"
    b"\x1b[1;32mmari@flashbox\x1b[0m:\x1b[1;34m~\x1b[0m$ "
)

JOURNAL = """2026-11-18T05:58:02+0000 flashbox python3[812]: POST /api/v1/submissions 201 ana 14.2ms
2026-11-18T05:58:40+0000 flashbox python3[812]: GET /marketplace/index.json 200 jonas 1.1ms
2026-11-18T06:00:12+0000 flashbox python3[812]: GET /updates/beta/latest.json 200 lee 0.8ms
2026-11-18T06:01:31+0000 flashbox python3[812]: GET /api/v1/admin/stats 200 mari 2.3ms"""


class DemoShell:
    def __init__(self, data: bytes = DEMO_SHELL):
        self._data: Optional[bytes] = data

    def recv(self, timeout: float = 0.2):
        if self._data:
            d, self._data = self._data, b""
            return d
        time.sleep(timeout)
        return b""

    def send(self, data: bytes) -> None:
        pass

    def resize(self, cols: int, rows: int) -> None:
        pass

    def close(self) -> None:
        self._data = None


class DemoSession:
    """Stands in for ssh.SshSession."""

    host_key_warning = None

    def __init__(self, profile: Profile):
        self.profile = profile
        self.connected = True

    def connect(self, timeout: float = 15) -> None:
        self.connected = True

    def close(self) -> None:
        self.connected = False

    def exec(self, cmd, *, sudo=False, sudo_user=None, on_line=None, running=None, timeout=None):
        if cmd.startswith("systemctl show"):
            out = ("ActiveState=active\nSubState=running\nMainPID=812\n"
                   "ActiveEnterTimestamp=Mon 2026-11-16 06:00:12 UTC\nLoadState=loaded")
        elif "PY=" in cmd:
            out = ("PY=3.12.3\nOS=Ubuntu 24.04.1 LTS\nSYSTEMD=255\nDISK=182400000000\nTMP=182400000000\nSUDO=password")
        elif cmd.startswith("journalctl"):
            out = JOURNAL
        elif cmd.startswith("cat "):
            out = '{\n  "name": "Body team flash server",\n  "host": "127.0.0.1",\n  "port": 8787,\n  "dataDir": "/var/lib/flash-server",\n  "publicRead": false\n}'
        else:
            out = ""
        if on_line:
            for line in out.splitlines():
                on_line(line)
        return 0, out

    def run(self, cmd, **kw):
        return self.exec(cmd, **kw)[1]

    def home(self):
        return "/home/mari"

    def listdir(self, path):
        if path.rstrip("/").endswith("mari"):
            return [{"name": n, "dir": d, "size": s, "mtime": time.time() - i * 3600, "mode": 0}
                    for i, (n, d, s) in enumerate([
                        ("backups", True, 0), ("plugins-src", True, 0), ("release", True, 0),
                        (".bashrc", False, 3771), ("flash-backup-20261117.tar.gz", False, 48_201_331),
                        ("notes.txt", False, 912)])]
        return []

    def open_shell(self, cols=120, rows=32, term="xterm-256color"):
        return DemoShell()


def demo_profiles():
    return [
        Profile(name="Body team server", host="flashbox.lan", user="mari", auth="key", key_file="~/.ssh/id_ed25519",
                server_port=8787, public_url="https://flash.body.example", id="demo1", admin_token="fs_demo"),
        Profile(name="Lab staging", host="10.0.4.21", port=2222, user="mari", auth="password",
                server_port=8787, id="demo2"),
    ]
