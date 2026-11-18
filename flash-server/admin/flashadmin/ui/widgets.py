"""Small reusable widgets: cards, banners, pills, log view, tables."""
from __future__ import annotations

from typing import Callable, Iterable, List, Optional

from PySide6.QtCore import QTimer, Qt, Signal
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (QAbstractItemView, QFrame, QHBoxLayout, QHeaderView, QLabel, QPlainTextEdit,
                               QPushButton, QSizePolicy, QTableWidget, QTableWidgetItem, QToolButton, QVBoxLayout,
                               QWidget)

from . import theme as th


def repolish(w: QWidget) -> None:
    w.style().unpolish(w)
    w.style().polish(w)
    w.update()


class Card(QFrame):
    def __init__(self, parent: Optional[QWidget] = None, margins: int = 20, spacing: int = 12, flat: bool = False):
        super().__init__(parent)
        self.setObjectName("card")
        if flat:
            self.setProperty("flat", True)
        self.lay = QVBoxLayout(self)
        self.lay.setContentsMargins(margins, margins - 2, margins, margins)
        self.lay.setSpacing(spacing)

    def add(self, w, stretch: int = 0):
        if isinstance(w, QWidget):
            self.lay.addWidget(w, stretch)
        else:
            self.lay.addLayout(w, stretch)
        return w


def label(text: str = "", name: str = "", wrap: bool = False, selectable: bool = False) -> QLabel:
    lb = QLabel(text)
    if name:
        lb.setObjectName(name)
    if wrap:
        lb.setWordWrap(True)
    if selectable:
        lb.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    return lb


def section(text: str) -> QLabel:
    return label(text.upper(), "section")


def button(text: str, kind: str = "", on_click: Optional[Callable] = None, tip: str = "") -> QPushButton:
    b = QPushButton(text)
    if kind:
        b.setProperty("kind", kind)
    b.setCursor(Qt.CursorShape.PointingHandCursor)
    if on_click:
        b.clicked.connect(lambda _=False: on_click())
    if tip:
        b.setToolTip(tip)
    return b


def hbox(*items, spacing: int = 10, margins=(0, 0, 0, 0)) -> QHBoxLayout:
    lay = QHBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for it in items:
        if it is None:
            lay.addStretch(1)
        elif isinstance(it, int):
            lay.addSpacing(it)
        elif isinstance(it, QWidget):
            lay.addWidget(it)
        else:
            lay.addLayout(it)
    return lay


def vbox(*items, spacing: int = 10, margins=(0, 0, 0, 0)) -> QVBoxLayout:
    lay = QVBoxLayout()
    lay.setSpacing(spacing)
    lay.setContentsMargins(*margins)
    for it in items:
        if it is None:
            lay.addStretch(1)
        elif isinstance(it, int):
            lay.addSpacing(it)
        elif isinstance(it, QWidget):
            lay.addWidget(it)
        else:
            lay.addLayout(it)
    return lay


def separator(vertical: bool = False) -> QFrame:
    f = QFrame()
    f.setObjectName("vsep" if vertical else "sep")
    return f


class Pill(QLabel):
    COLORS = {"active": "green", "running": "green", "connected": "green", "ok": "green", "approved": "green",
              "pending": "amber", "connecting": "amber", "activating": "amber", "changes_requested": "amber",
              "draft": "muted", "inactive": "muted", "disconnected": "muted", "withdrawn": "muted",
              "failed": "red", "error": "red", "rejected": "red", "disabled": "red",
              "admin": "accent", "beta": "blue", "stable": "green", "user": "muted"}

    def __init__(self, text: str = "", color: str = "", dot: Optional[bool] = None):
        super().__init__()
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self.set(text, color, dot)

    def set(self, text: str, color: str = "", dot: Optional[bool] = None) -> None:
        color = color or self.COLORS.get(text.lower().replace(" ", "_"), "muted")
        if dot is None:
            dot = color in ("green", "amber", "red")
        self.setText(f"●  {text}" if dot else text)
        self.setProperty("pill", color)
        repolish(self)


class Banner(QFrame):
    """Inline message bar (error / warn / info / ok) with a close button."""

    ICONS = {"error": "✕", "warn": "!", "info": "i", "ok": "✓"}

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self.setObjectName("banner")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(14, 10, 8, 10)
        lay.setSpacing(10)
        self.icon = label("", "bannerIcon")
        f = self.icon.font()
        f.setBold(True)
        self.icon.setFont(f)
        self.icon.setFixedWidth(14)
        self.icon.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignHCenter)
        self.text = label("", wrap=True, selectable=True)
        self.text.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        close = QToolButton()
        close.setText("✕")
        close.setProperty("kind", "ghost")
        close.setCursor(Qt.CursorShape.PointingHandCursor)
        close.clicked.connect(self.hide)
        lay.addWidget(self.icon)
        lay.addWidget(self.text, 1)
        lay.addWidget(close, 0, Qt.AlignmentFlag.AlignTop)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.hide)
        self.hide()

    def show_message(self, kind: str, text: str, timeout_ms: int = 0) -> None:
        self.setProperty("kind", kind)
        self.icon.setText(self.ICONS.get(kind, "i"))
        self.text.setText(text)
        repolish(self)
        repolish(self.icon)
        self.show()
        if timeout_ms:
            self._timer.start(timeout_ms)
        else:
            self._timer.stop()


class LogView(QPlainTextEdit):
    def __init__(self, parent: Optional[QWidget] = None, max_lines: int = 5000):
        super().__init__(parent)
        self.setObjectName("log")
        self.setReadOnly(True)
        self.setMaximumBlockCount(max_lines)
        self.setFont(th.mono_font(12))
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.setPlaceholderText("Output appears here.")

    def append_line(self, line: str) -> None:
        bar = self.verticalScrollBar()
        at_end = bar.value() >= bar.maximum() - 4
        self.appendPlainText(line)
        if at_end:
            self.moveCursor(QTextCursor.MoveOperation.End)
            bar.setValue(bar.maximum())


class StatCard(Card):
    def __init__(self, title: str, value: str = "–", hint: str = ""):
        super().__init__(margins=18, spacing=4)
        self.title = label(title, "statLabel")
        self.value = label(value, "stat")
        self.hint = label(hint, "small")
        self.add(self.title)
        self.add(self.value)
        self.add(self.hint)
        self.setMinimumHeight(118)

    def set(self, value: str, hint: str = "") -> None:
        self.value.setText(value)
        self.hint.setText(hint)


def table(headers: List[str], stretch_col: int = -1) -> QTableWidget:
    t = QTableWidget(0, len(headers))
    t.setHorizontalHeaderLabels(headers)
    t.verticalHeader().setVisible(False)
    t.verticalHeader().setDefaultSectionSize(40)
    t.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
    t.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
    t.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
    t.setShowGrid(False)
    t.setFocusPolicy(Qt.FocusPolicy.NoFocus)
    t.setWordWrap(False)
    hh = t.horizontalHeader()
    hh.setDefaultAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
    hh.setHighlightSections(False)
    hh.setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
    hh.setStretchLastSection(stretch_col < 0)
    if stretch_col >= 0:
        hh.setSectionResizeMode(stretch_col, QHeaderView.ResizeMode.Stretch)
    return t


def item(text, data=None, mono: bool = False, muted: bool = False, color: str = "") -> QTableWidgetItem:
    it = QTableWidgetItem("" if text is None else str(text))
    if data is not None:
        it.setData(Qt.ItemDataRole.UserRole, data)
    if mono:
        it.setFont(th.mono_font(12))
    if muted or color:
        from PySide6.QtGui import QBrush, QColor

        it.setForeground(QBrush(QColor(color or "#8a90a4")))
    return it


def short_time(iso: Optional[str]) -> str:
    if not iso:
        return "–"
    return iso.replace("T", " ").replace("Z", "")[:16]


def ago(iso: Optional[str]) -> str:
    import datetime as dt

    if not iso:
        return "never"
    try:
        t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    s = (dt.datetime.now(dt.timezone.utc) - t).total_seconds()
    if s < 90:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)} min ago"
    if s < 86400:
        return f"{int(s // 3600)} h ago"
    return f"{int(s // 86400)} d ago"
