from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QTabWidget, QToolButton

from ..page import Page
from ..terminal_widget import TerminalWidget
from ..widgets import button, label


class TerminalPage(Page):
    title = "Terminal"
    nav_label = "Terminal"
    subtitle = "Interactive SSH shells on the server"
    icon = "terminal"
    needs = "ssh"

    def build(self) -> None:
        self.hint = label("Copy: Ctrl+Shift+C (⌘C)   Paste: Ctrl+Shift+V (⌘V)   Scroll: wheel / Shift+PgUp", "small")
        self.actions.addWidget(self.hint)
        self.actions.addSpacing(12)
        self.actions.addWidget(button("New tab", "", self.new_tab))
        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.tabs.setMovable(True)
        self.tabs.tabCloseRequested.connect(self._close_tab)
        self.body.addWidget(self.tabs, 1)
        self._count = 0

    def apply_theme(self, t) -> None:
        for i in range(self.tabs.count()):
            self.tabs.widget(i).set_theme(t)

    def refresh(self) -> None:
        if self.tabs.count() == 0:
            self.new_tab()

    def connection_changed(self) -> None:
        if not self.ctx.connected and hasattr(self, "tabs"):
            while self.tabs.count():
                self._close_tab(0)

    def new_tab(self) -> None:
        if not self.ctx.connected:
            return
        self._count += 1
        term = TerminalWidget()
        if self.ctx.theme is not None:
            term.set_theme(self.ctx.theme)
        name = f"{self.ctx.profile.host if self.ctx.profile else 'shell'} · {self._count}"
        idx = self.tabs.addTab(term, name)
        self.tabs.setCurrentIndex(idx)
        close = QToolButton()
        close.setText("✕")
        close.setProperty("kind", "ghost")
        close.setStyleSheet("padding: 0px 4px; font-size: 11px;")
        close.setCursor(Qt.CursorShape.PointingHandCursor)
        close.clicked.connect(lambda _=False, w=term: self._close_tab(self.tabs.indexOf(w)))
        self.tabs.tabBar().setTabButton(idx, self.tabs.tabBar().ButtonPosition.RightSide, close)
        term.title_changed.connect(lambda t, w=term: self._retitle(w, t))
        session = self.ctx.session
        cols, rows = term.model.cols, term.model.rows

        def done(shell):
            term.attach(shell)
            term.setFocus()

        self.task(lambda: session.open_shell(cols, rows), done)

    def _retitle(self, w, title: str) -> None:
        i = self.tabs.indexOf(w)
        if i >= 0 and title:
            self.tabs.setTabText(i, title[:32])

    def _close_tab(self, i: int) -> None:
        if i < 0:
            return
        w = self.tabs.widget(i)
        self.tabs.removeTab(i)
        if w is not None:
            w.close_shell()
            w.deleteLater()
