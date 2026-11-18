"""Main window: painted wallpaper, glass sidebar with icon navigation, stacked pages."""
from __future__ import annotations

from typing import Dict, List

from PySide6.QtCore import QPointF, QRectF, QSize, Qt
from PySide6.QtGui import QBrush, QColor, QPainter, QRadialGradient
from PySide6.QtWidgets import (QApplication, QButtonGroup, QFrame, QHBoxLayout, QLabel, QMainWindow, QSizePolicy,
                               QStackedWidget, QToolButton, QVBoxLayout, QWidget)

from .. import __version__
from . import icons
from . import theme as th
from .context import AppContext
from .pages.connections import ConnectionsPage
from .pages.dashboard import DashboardPage
from .pages.deploy import DeployPage
from .pages.marketplace import MarketplacePage
from .pages.releases import ReleasesPage
from .pages.review import ReviewPage
from .pages.terminal import TerminalPage
from .pages.transfer import TransferPage
from .pages.users import UsersPage
from .widgets import Pill, label, repolish


class Backdrop(QWidget):
    """Window background: the app's radial-gradient wallpaper."""

    def __init__(self, ctx: AppContext):
        super().__init__()
        self.ctx = ctx

    def paintEvent(self, _e) -> None:
        t = self.ctx.theme or th.DARK
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = self.rect()
        p.fillRect(r, QColor(t.win_base))
        w, h = r.width(), r.height()
        for fx, fy, radius, (cr, cg, cb, ca) in t.wallpaper:
            g = QRadialGradient(QPointF(fx * w, fy * h), radius * max(w, h) * 0.75)
            g.setColorAt(0.0, QColor(cr, cg, cb, int(ca * 255)))
            g.setColorAt(0.6, QColor(cr, cg, cb, 0))
            g.setColorAt(1.0, QColor(cr, cg, cb, 0))
            p.fillRect(r, QBrush(g))
        p.end()


class NavButton(QToolButton):
    def __init__(self, key: str, text: str, icon_name: str):
        super().__init__()
        self.key, self.icon_name = key, icon_name
        self.setObjectName("nav")
        self.setText("  " + text)
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.setIconSize(QSize(18, 18))
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setMinimumHeight(40)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 10, 0)
        lay.addStretch(1)
        self.badge = label("", "badge")
        self.badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.badge.setFixedHeight(20)
        self.badge.setMinimumWidth(22)
        self.badge.hide()
        lay.addWidget(self.badge, 0, Qt.AlignmentFlag.AlignVCenter)

    def set_badge(self, n: int) -> None:
        self.badge.setText(str(n))
        self.badge.setVisible(n > 0)


class MainWindow(QMainWindow):
    PAGES = [
        ("dashboard", DashboardPage), ("connections", ConnectionsPage), ("deploy", DeployPage),
        ("transfer", TransferPage), ("terminal", TerminalPage), ("review", ReviewPage),
        ("marketplace", MarketplacePage), ("releases", ReleasesPage), ("users", UsersPage),
    ]

    def __init__(self, ctx: AppContext, theme_mode: str = "auto"):
        super().__init__()
        self.ctx = ctx
        self.theme_mode = theme_mode
        self.setWindowTitle("Flash Admin")
        self.resize(1440, 900)
        self.setMinimumSize(1100, 700)
        ctx.theme = self._resolve_theme()

        root = Backdrop(ctx)
        self.setCentralWidget(root)
        lay = QHBoxLayout(root)
        lay.setContentsMargins(14, 14, 14, 14)
        lay.setSpacing(6)

        self.sidebar = QFrame()
        self.sidebar.setObjectName("sidebar")
        self.sidebar.setFixedWidth(248)
        side = QVBoxLayout(self.sidebar)
        side.setContentsMargins(14, 18, 14, 14)
        side.setSpacing(3)

        brand = QHBoxLayout()
        brand.setSpacing(10)
        brand.setContentsMargins(8, 0, 0, 0)
        self.brand_icon = QLabel()
        brand.addWidget(self.brand_icon)
        brand_text = QVBoxLayout()
        brand_text.setSpacing(0)
        brand_text.addWidget(label("Flash Admin", "brand"))
        brand_text.addWidget(label("server console", "small"))
        brand.addLayout(brand_text)
        brand.addStretch(1)
        side.addLayout(brand)
        side.addSpacing(16)

        self.conn_card = QFrame()
        self.conn_card.setObjectName("connCard")
        self.conn_card.setCursor(Qt.CursorShape.PointingHandCursor)
        cc = QVBoxLayout(self.conn_card)
        cc.setContentsMargins(12, 10, 12, 11)
        cc.setSpacing(5)
        self.conn_name = label("No server", "h2")
        self.conn_name.setStyleSheet("font-size: 13.5px;")
        self.conn_target = label("Pick a profile in Connections", "small")
        self.conn_pill = Pill("disconnected")
        cc.addWidget(self.conn_name)
        cc.addWidget(self.conn_target)
        pill_row = QHBoxLayout()
        pill_row.addWidget(self.conn_pill)
        pill_row.addStretch(1)
        cc.addLayout(pill_row)
        self.conn_card.mousePressEvent = lambda _e: self.navigate("connections")
        side.addWidget(self.conn_card)
        side.addSpacing(14)

        self.stack = QStackedWidget()
        self.pages: Dict[str, object] = {}
        self.nav: Dict[str, NavButton] = {}
        group = QButtonGroup(self)
        group.setExclusive(True)
        for key, cls in self.PAGES:
            page = cls(ctx)
            page.go_to.connect(self.navigate)
            self.pages[key] = page
            self.stack.addWidget(page)
            btn = NavButton(key, cls.nav_label if hasattr(cls, "nav_label") else cls.title, cls.icon)
            btn.clicked.connect(lambda _=False, k=key: self.navigate(k))
            group.addButton(btn)
            self.nav[key] = btn
            side.addWidget(btn)
            if key == "connections" or key == "terminal":
                side.addSpacing(10)
        side.addStretch(1)

        foot = QHBoxLayout()
        foot.setContentsMargins(8, 0, 0, 0)
        foot.addWidget(label(f"v{__version__}", "small"))
        foot.addStretch(1)
        self.theme_btn = QToolButton()
        self.theme_btn.setProperty("kind", "ghost")
        self.theme_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.theme_btn.setToolTip("Theme: follow system / dark / light")
        self.theme_btn.clicked.connect(self._cycle_theme)
        foot.addWidget(self.theme_btn)
        side.addLayout(foot)

        lay.addWidget(self.sidebar)
        lay.addWidget(self.stack, 1)

        ctx.changed.connect(self._update_conn)
        ctx.pending_count.connect(lambda n: self.nav["review"].set_badge(n))
        ctx.notice.connect(self._notice)
        hints = QApplication.styleHints()
        if hasattr(hints, "colorSchemeChanged"):
            hints.colorSchemeChanged.connect(lambda *_: self.theme_mode == "auto" and self.apply_theme())
        self.apply_theme()
        self._update_conn()
        self.navigate("dashboard" if ctx.store.profiles else "connections")

    # --------------------------------------------------------------- theme
    def _resolve_theme(self) -> th.Theme:
        if self.theme_mode == "dark":
            return th.DARK
        if self.theme_mode == "light":
            return th.LIGHT
        return th.DARK if th.system_is_dark() else th.LIGHT

    def _cycle_theme(self) -> None:
        order = ["auto", "dark", "light"]
        self.theme_mode = order[(order.index(self.theme_mode) + 1) % 3]
        self.apply_theme()

    def apply_theme(self) -> None:
        t = self._resolve_theme()
        self.ctx.theme = t
        app = QApplication.instance()
        app.setPalette(th.palette_for(t))
        app.setStyleSheet(th.stylesheet(t))
        self.brand_icon.setPixmap(icons.pixmap("bolt", t.accent, 26, width=1.6, fill=True))
        for btn in self.nav.values():
            btn.setIcon(icons.icon(btn.icon_name, t.muted, 18, active=t.accent))
        self.theme_btn.setText({"auto": "◐  Auto", "dark": "●  Dark", "light": "○  Light"}[self.theme_mode])
        for page in self.pages.values():
            page.apply_theme(t)
            page._ctx_changed() if not page.ready() else None
        self.ctx.theme_changed.emit(t)
        self.centralWidget().update()

    # ----------------------------------------------------------- behaviour
    def navigate(self, key: str) -> None:
        if key not in self.pages:
            return
        self.nav[key].setChecked(True)
        self.stack.setCurrentWidget(self.pages[key])
        self.pages[key].on_show()

    def current_page(self):
        return self.stack.currentWidget()

    def _notice(self, kind: str, text: str) -> None:
        self.current_page().show_banner(kind, text)

    def _update_conn(self) -> None:
        p = self.ctx.profile
        self.conn_name.setText(p.name if p else "No server")
        self.conn_target.setText(p.display_target() if p else "Pick a profile in Connections")
        state = self.ctx.state
        if state == "connected" and self.ctx.server_info.get("version"):
            self.conn_pill.set(f"connected · v{self.ctx.server_info['version']}", "green")
        else:
            self.conn_pill.set(state)
