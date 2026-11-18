"""Render every page of the admin app with the demo backend and save PNGs.

    python tools/screenshots.py <out-dir>      (from flash-server/admin)

1440x900 logical, device pixel ratio 2; dark for all pages, light for two.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ["QT_SCALE_FACTOR"] = "2"
os.environ.setdefault("FLASH_ADMIN_HOME", os.path.join(tempfile.gettempdir(), "flash-admin-demo", "home"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flashadmin.app import build_window  # noqa: E402
from flashadmin.ui.workers import wait_idle  # noqa: E402

PAGES = ["dashboard", "connections", "deploy", "transfer", "terminal", "review", "marketplace", "releases", "users"]
LIGHT = ["dashboard", "review"]


def settle(app, seconds: float = 0.25) -> None:
    end = time.time() + seconds
    while time.time() < end:
        wait_idle(app, 2000)
        app.processEvents()
        time.sleep(0.03)


def prepare(win, key: str) -> None:
    page = win.pages[key]
    if key == "releases":
        page.table.selectRow(0)
    if key == "marketplace":
        page.tree.setCurrentItem(page.tree.topLevelItem(1).child(0))
    if key == "users":
        page.table.selectRow(1)
        page._show_token("Token for ana", "ana", "fs_Q3v9xK2mL7pR4tW8yZ1aB5cD6eF0gH2jN4sU6wX8")
    if key == "deploy":
        out = page.out
        for line in ["» packed 23 files (61.4 KB) from /home/mari/the-flash-master/flash-server",
                     "» uploading to /tmp/flash-admin.k2J9xa/flash-server.tar.gz",
                     "» sudo bash deploy/install.sh --port 8787",
                     "[install] python3 3.12.3 ok", "[install] user 'flash' exists",
                     "[install] code → /opt/flash-server", "[install] config kept: /etc/flash-server/config.json",
                     "[install] systemctl restart flash-server", "[install] health: ok (v1.0.0)", "» done"]:
            out.append_line(line)
        page._show_prereqs([
            {"name": "Python 3.10+", "ok": True, "value": "3.12.3", "hint": ""},
            {"name": "Operating system", "ok": True, "value": "Ubuntu 24.04.1 LTS", "hint": ""},
            {"name": "systemd", "ok": True, "value": "255", "hint": ""},
            {"name": "Free disk (/var/lib)", "ok": True, "value": 182400000000, "hint": ""},
        ])
        page.banner.hide()
        page.tabs.setCurrentIndex(0)
    if key == "transfer":
        demo = os.path.join(tempfile.gettempdir(), "flash-admin-demo", "mari")
        for d in ("release", "plugins-src/body-sw-test-pack/agents", "backups"):
            os.makedirs(os.path.join(demo, d), exist_ok=True)
        for name, size in (("TheFlashMaster-0.6.0-beta.3-x64-setup.exe", 4096), ("notes.txt", 900),
                           ("flash-backup-20261110.tar.gz", 20000)):
            with open(os.path.join(demo, name), "wb") as fh:
                fh.write(b"\0" * size)
        page._set_local(demo)
        page.progress.setValue(64)
        page.progress_label.setText("flash-backup-20261118.tar.gz  30.8 MB / 48.2 MB")
        page.log.append_line("» flashserver backup /var/lib/flash-server/backups/flash-backup-20261118-0612.tar.gz")
        page.log.append_line("» downloading to /home/mari/flash-backup-20261118.tar.gz")


def main(out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    app, ctx, win = build_window(demo=True, theme="dark")
    win.resize(1440, 900)
    win.show()
    ctx.connect_profile(ctx.store.profiles[0])
    settle(app, 0.5)
    saved = []

    def shoot(key: str, suffix: str) -> None:
        win.navigate(key)
        settle(app, 0.6 if key == "terminal" else 0.3)
        prepare(win, key)
        settle(app, 0.15)
        win.pages[key].banner.hide()
        app.processEvents()
        pm = win.grab()
        path = os.path.join(out_dir, f"admin-{key}{suffix}.png")
        pm.save(path)
        saved.append(path)

    for key in PAGES:
        shoot(key, "")
    win.theme_mode = "light"
    win.apply_theme()
    for key in LIGHT:
        shoot(key, "-light")
    for p in saved:
        print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "screenshots"))
