"""Entry point: python -m flashadmin [--demo] [--theme auto|dark|light]."""
from __future__ import annotations

import argparse
import sys


def build_window(demo: bool = False, theme: str = "auto", store=None):
    from PySide6.QtWidgets import QApplication

    from .profiles import ProfileStore
    from .ui.context import AppContext
    from .ui.main_window import MainWindow
    from .ui import theme as th

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("Flash Admin")
    app.setStyle("Fusion")
    from PySide6.QtGui import QFont

    f = QFont(th.pick_family(th.UI_FONTS))
    f.setPixelSize(13)
    app.setFont(f)
    if store is None:
        store = ProfileStore()
        if demo:
            from .demo import demo_profiles

            store.path = "/nonexistent/demo-profiles.json"
            store.profiles = demo_profiles()
            store.save = lambda: None  # type: ignore[assignment]
        else:
            try:
                store.load()
            except Exception as e:  # corrupt file: start empty, keep the file
                print(f"warning: cannot read {store.path}: {e}", file=sys.stderr)
    ctx = AppContext(store, demo=demo)
    win = MainWindow(ctx, theme)
    return app, ctx, win


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="flashadmin", description="Flash Server admin console")
    ap.add_argument("--demo", action="store_true", help="run against a fake server (no SSH)")
    ap.add_argument("--theme", choices=["auto", "dark", "light"], default="auto")
    args = ap.parse_args(argv)
    app, ctx, win = build_window(args.demo, args.theme)
    win.show()
    if args.demo and ctx.store.profiles:
        ctx.connect_profile(ctx.store.profiles[0])
    else:
        last = ctx.store.get(ctx.store.last_used) if ctx.store.last_used else None
        if last is not None:
            ctx.profile = last
            ctx.changed.emit()
    return app.exec()
