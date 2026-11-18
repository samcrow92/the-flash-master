"""Base class for sidebar pages: header, inline banner, empty state when not connected, task helper."""
from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QPushButton, QStackedWidget, QVBoxLayout, QWidget

from . import icons
from .widgets import Banner, button, hbox, label, vbox
from .workers import run_task


class Page(QWidget):
    title = ""
    subtitle = ""
    icon = "home"
    needs: Optional[str] = "ssh"   # None | "ssh" | "api"
    go_to = Signal(str)            # ask the main window to switch pages

    def __init__(self, ctx):
        super().__init__()
        self.ctx = ctx
        self._loaded_once = False
        outer = QVBoxLayout(self)
        outer.setContentsMargins(34, 28, 34, 26)
        outer.setSpacing(16)
        self.title_label = label(self.title, "h1")
        self.subtitle_label = label(self.subtitle, "subtitle")
        self.actions = hbox(spacing=8)
        outer.addLayout(hbox(vbox(self.title_label, self.subtitle_label, spacing=2), None, self.actions))
        self.banner = Banner()
        outer.addWidget(self.banner)
        self.stack = QStackedWidget()
        outer.addWidget(self.stack, 1)
        self.content = QWidget()
        self.body = QVBoxLayout(self.content)
        self.body.setContentsMargins(0, 4, 0, 0)
        self.body.setSpacing(16)
        self.stack.addWidget(self.content)
        self.empty = self._empty_state()
        self.stack.addWidget(self.empty)
        self.build()
        ctx.changed.connect(self._ctx_changed)
        self._ctx_changed()

    # ------------------------------------------------------------ override
    def build(self) -> None:
        pass

    def refresh(self) -> None:
        pass

    def apply_theme(self, theme) -> None:
        pass

    # ------------------------------------------------------------- helpers
    def _empty_state(self) -> QWidget:
        w = QWidget()
        ic = label()
        self._empty_icon = ic
        ic.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_title = label("Not connected", "h2")
        self._empty_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_text = label("Connect to a server profile to use this page.", "muted")
        self._empty_text.setAlignment(Qt.AlignmentFlag.AlignCenter)
        b = button("Open Connections", "primary", lambda: self.go_to.emit("connections"))
        lay = vbox(None, ic, self._empty_title, self._empty_text, 6, hbox(None, b, None), None, spacing=8)
        w.setLayout(lay)
        return w

    def ready(self) -> bool:
        if self.needs is None:
            return True
        if self.needs == "api":
            return self.ctx.api_ready
        return self.ctx.connected

    def _ctx_changed(self) -> None:
        ok = self.ready()
        if not ok:
            if self.ctx.connected and self.needs == "api":
                self._empty_title.setText("No admin token")
                self._empty_text.setText("Install the server from Setup & deploy, or paste the admin token in Connections.")
            elif self.ctx.state == "connecting":
                self._empty_title.setText("Connecting…")
                self._empty_text.setText(f"Opening SSH to {self.ctx.profile.display_target() if self.ctx.profile else ''}")
            else:
                self._empty_title.setText("Not connected")
                self._empty_text.setText("Connect to a server profile to use this page.")
            if self.ctx.theme is not None:
                self._empty_icon.setPixmap(icons.pixmap(self.icon, self.ctx.theme.muted, 44, width=1.4))
        self.stack.setCurrentIndex(0 if ok else 1)
        if ok and self.isVisible():
            self.refresh()
        self.connection_changed()

    def connection_changed(self) -> None:
        pass

    def on_show(self) -> None:
        if self.ready():
            self.refresh()

    def show_banner(self, kind: str, text: str) -> None:
        self.banner.show_message(kind, text, 7000 if kind in ("ok", "info") else 0)

    def error(self, text: str) -> None:
        self.show_banner("error", text)

    def ok(self, text: str) -> None:
        self.show_banner("ok", text)

    def task(self, fn: Callable, done: Optional[Callable] = None, *, busy: Optional[QPushButton] = None,
             progress: Optional[Callable] = None, error: Optional[Callable] = None,
             finished: Optional[Callable] = None):
        if busy is not None:
            busy.setEnabled(False)

        def fin():
            if busy is not None:
                busy.setEnabled(True)
            if finished:
                finished()

        return run_task(fn, done, error or self.error, progress, fin)
