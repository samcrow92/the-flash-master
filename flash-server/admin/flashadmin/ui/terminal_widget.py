"""Terminal widget: draws a TerminalModel (pyte) and turns key presses into xterm bytes."""
from __future__ import annotations

import sys
import threading
from typing import Optional, Tuple

from PySide6.QtCore import QObject, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontMetricsF, QGuiApplication, QKeyEvent, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QMenu, QWidget

from ..terminal import ANSI_DARK, ANSI_LIGHT, TerminalModel, bracketed_paste, map_key, resolve_color
from . import theme as th

IS_MAC = sys.platform == "darwin"

QT_KEYS = {
    Qt.Key.Key_Up: "Up", Qt.Key.Key_Down: "Down", Qt.Key.Key_Left: "Left", Qt.Key.Key_Right: "Right",
    Qt.Key.Key_Home: "Home", Qt.Key.Key_End: "End", Qt.Key.Key_PageUp: "PageUp", Qt.Key.Key_PageDown: "PageDown",
    Qt.Key.Key_Insert: "Insert", Qt.Key.Key_Delete: "Delete", Qt.Key.Key_Backspace: "Backspace",
    Qt.Key.Key_Tab: "Tab", Qt.Key.Key_Backtab: "Backtab", Qt.Key.Key_Return: "Enter", Qt.Key.Key_Enter: "Enter",
    Qt.Key.Key_Escape: "Escape",
    **{getattr(Qt.Key, f"Key_F{i}"): f"F{i}" for i in range(1, 13)},
}
PAD = 12


class _Bridge(QObject):
    data = Signal(bytes)
    closed = Signal()


class TerminalWidget(QWidget):
    resized = Signal(int, int)
    title_changed = Signal(str)

    def __init__(self, shell=None, parent: Optional[QWidget] = None, font_px: float = 13):
        super().__init__(parent)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_InputMethodEnabled, True)
        self.setCursor(Qt.CursorShape.IBeamCursor)
        self.setMinimumSize(320, 160)
        self.shell = shell
        self.model = TerminalModel(100, 30, reply=self._send)
        self.theme = th.DARK
        self.set_font_px(font_px)
        self._sel: Optional[Tuple[Tuple[int, int], Tuple[int, int]]] = None
        self._sel_anchor: Optional[Tuple[int, int]] = None
        self._closed = False
        self._bridge = _Bridge()
        self._bridge.data.connect(self.feed)
        self._bridge.closed.connect(self._on_closed)
        self._reader: Optional[threading.Thread] = None

    # --------------------------------------------------------------- setup
    def set_font_px(self, px: float) -> None:
        self.font_regular = th.mono_font(px)
        self.font_bold = QFont(self.font_regular)
        self.font_bold.setBold(True)
        fm = QFontMetricsF(self.font_regular)
        self.cw = fm.horizontalAdvance("M")
        self.ch = fm.lineSpacing()
        self.ascent = fm.ascent()
        self._relayout()

    def set_theme(self, t) -> None:
        self.theme = t
        self.update()

    def attach(self, shell) -> None:
        self.shell = shell
        self._closed = False
        shell.resize(self.model.cols, self.model.rows)
        self._reader = threading.Thread(target=self._read_loop, name="flash-term", daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        shell = self.shell
        while shell is not None and not self._closed:
            try:
                data = shell.recv(0.2)
            except Exception:
                data = None
            if data is None:
                self._bridge.closed.emit()
                return
            if data:
                self._bridge.data.emit(data)

    def close_shell(self) -> None:
        self._closed = True
        if self.shell is not None:
            try:
                self.shell.close()
            except Exception:
                pass

    def _on_closed(self) -> None:
        if not self._closed:
            self._closed = True
            self.feed(b"\r\n\x1b[2m[connection closed]\x1b[0m\r\n")

    def feed(self, data: bytes) -> None:
        self.model.feed(data)
        title = getattr(self.model.screen, "title", "")
        if title:
            self.title_changed.emit(title)
        self.update()

    def _send(self, data: bytes) -> None:
        if self.shell is not None and not self._closed and data:
            try:
                self.shell.send(data)
            except Exception:
                self._on_closed()

    # -------------------------------------------------------------- layout
    def _relayout(self) -> None:
        cols = max(10, int((self.width() - 2 * PAD) // self.cw)) if self.width() > 0 else 100
        rows = max(4, int((self.height() - 2 * PAD) // self.ch)) if self.height() > 0 else 30
        if self.model.resize(cols, rows):
            self.resized.emit(cols, rows)
            if self.shell is not None and not self._closed:
                self.shell.resize(cols, rows)

    def resizeEvent(self, e) -> None:
        self._relayout()
        super().resizeEvent(e)

    def _cell_at(self, pos) -> Tuple[int, int]:
        x = int((pos.x() - PAD) // self.cw)
        y = int((pos.y() - PAD) // self.ch)
        return max(0, min(self.model.cols - 1, x)), max(0, min(self.model.rows - 1, y))

    # --------------------------------------------------------------- paint
    def paintEvent(self, _e) -> None:
        t = self.theme
        pal = ANSI_DARK if t.dark else ANSI_LIGHT
        dfg, dbg = t.terminal_fg, t.terminal_bg
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        path = QPainterPath()
        path.addRoundedRect(QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5), 12, 12)
        p.fillPath(path, QColor(dbg))
        p.setPen(QPen(t.qcolor("rim") if t.dark else QColor(0, 0, 0, 28), 1))
        p.drawPath(path)
        p.setClipPath(path)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        p.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        sel = self._normalized_sel()
        sel_color = QColor(t.accent)
        sel_color.setAlpha(80)
        for y, line in enumerate(self.model.visible_lines()):
            top = PAD + y * self.ch
            for start, text, st in TerminalModel.runs(line):
                fg = resolve_color(st.fg, pal, dfg, st.bold)
                bg = resolve_color(st.bg, pal, dbg)
                if st.reverse:
                    fg, bg = bg, fg
                x = PAD + start * self.cw
                if bg != dbg:
                    p.fillRect(QRectF(x, top, len(text) * self.cw + 0.5, self.ch), QColor(bg))
                if text.strip():
                    p.setFont(self.font_bold if st.bold else self.font_regular)
                    p.setPen(QColor(fg))
                    for i, chx in enumerate(text):
                        if chx != " ":
                            p.drawText(QPointF(x + i * self.cw, top + self.ascent), chx)
                    if st.underscore:
                        p.drawLine(QPointF(x, top + self.ch - 1.5), QPointF(x + len(text) * self.cw, top + self.ch - 1.5))
            if sel and sel[0][1] <= y <= sel[1][1]:
                a = sel[0][0] if y == sel[0][1] else 0
                b = sel[1][0] if y == sel[1][1] else self.model.cols - 1
                p.fillRect(QRectF(PAD + a * self.cw, top, (b - a + 1) * self.cw, self.ch), sel_color)
        cur = self.model.cursor()
        if cur is not None and not self._closed:
            cx, cy = cur
            r = QRectF(PAD + cx * self.cw, PAD + cy * self.ch, self.cw, self.ch)
            c = QColor(t.accent)
            if self.hasFocus():
                c.setAlpha(210)
                p.fillRect(r, c)
                line = self.model.visible_lines()[cy] if cy < self.model.rows else []
                if cx < len(line) and line[cx][0].strip():
                    p.setPen(QColor(t.accent_fg))
                    p.setFont(self.font_regular)
                    p.drawText(QPointF(r.x(), r.y() + self.ascent), line[cx][0])
            else:
                p.setPen(QPen(c, 1))
                p.drawRect(r.adjusted(0.5, 0.5, -0.5, -0.5))
        if self.model.scroll:
            p.setPen(QColor(t.muted))
            p.setFont(self.font_regular)
            txt = f"↑ {self.model.scroll} lines"
            p.drawText(QPointF(self.width() - PAD - len(txt) * self.cw, PAD + self.ascent), txt)
        p.end()

    # ------------------------------------------------------------ keyboard
    def focusNextPrevChild(self, _next: bool) -> bool:
        return False  # Tab goes to the shell

    def event(self, e):
        if e.type() == e.Type.ShortcutOverride:
            e.accept()  # keep Ctrl+… for the terminal
            return True
        return super().event(e)

    def keyPressEvent(self, e: QKeyEvent) -> None:
        mods = e.modifiers()
        # On macOS Qt reports Cmd as Control and the Ctrl key as Meta.
        cmd = bool(mods & Qt.KeyboardModifier.ControlModifier) if IS_MAC else False
        ctrl = bool(mods & (Qt.KeyboardModifier.MetaModifier if IS_MAC else Qt.KeyboardModifier.ControlModifier))
        shift = bool(mods & Qt.KeyboardModifier.ShiftModifier)
        alt = bool(mods & Qt.KeyboardModifier.AltModifier)
        key = e.key()
        if (cmd and key == Qt.Key.Key_C) or (not IS_MAC and ctrl and shift and key == Qt.Key.Key_C):
            self.copy()
            return
        if (cmd and key == Qt.Key.Key_V) or (not IS_MAC and ctrl and shift and key == Qt.Key.Key_V) or \
                (shift and key == Qt.Key.Key_Insert):
            self.paste()
            return
        if shift and key in (Qt.Key.Key_PageUp, Qt.Key.Key_PageDown):
            self.model.scroll_by((self.model.rows - 1) * (1 if key == Qt.Key.Key_PageUp else -1))
            self.update()
            return
        name = QT_KEYS.get(key)
        text = e.text()
        if ctrl and name is None and Qt.Key.Key_A <= key <= Qt.Key.Key_Z:
            text = chr(key)
        elif ctrl and name is None and key in (Qt.Key.Key_Space, Qt.Key.Key_BracketLeft, Qt.Key.Key_Backslash,
                                               Qt.Key.Key_BracketRight, Qt.Key.Key_Underscore, Qt.Key.Key_Minus,
                                               Qt.Key.Key_At, Qt.Key.Key_AsciiCircum, Qt.Key.Key_Question):
            text = chr(key) if key < 128 else text
        data = map_key(name, text, ctrl=ctrl, alt=alt, shift=shift, app_cursor=self.model.app_cursor)
        if data:
            if self.model.scroll:
                self.model.scroll = 0
            self._sel = None
            self._send(data)
            self.update()

    def inputMethodEvent(self, e) -> None:
        if e.commitString():
            self._send(e.commitString().encode("utf-8"))

    # ----------------------------------------------------- mouse / clipboard
    def wheelEvent(self, e) -> None:
        steps = e.angleDelta().y() / 40
        self.model.scroll_by(int(round(steps)))
        self.update()

    def mousePressEvent(self, e) -> None:
        self.setFocus()
        if e.button() == Qt.MouseButton.LeftButton:
            self._sel_anchor = self._cell_at(e.position())
            self._sel = None
            self.update()
        elif e.button() == Qt.MouseButton.MiddleButton:
            self.paste(QGuiApplication.clipboard().text(QGuiApplication.clipboard().Mode.Selection))

    def mouseMoveEvent(self, e) -> None:
        if self._sel_anchor is not None:
            self._sel = (self._sel_anchor, self._cell_at(e.position()))
            self.update()

    def mouseReleaseEvent(self, e) -> None:
        self._sel_anchor = None
        if self._sel and self._sel[0] != self._sel[1]:
            cb = QGuiApplication.clipboard()
            if cb.supportsSelection():
                cb.setText(self.selected_text(), cb.Mode.Selection)

    def contextMenuEvent(self, e) -> None:
        m = QMenu(self)
        m.addAction("Copy", self.copy).setEnabled(bool(self._sel))
        m.addAction("Paste", self.paste)
        m.addSeparator()
        m.addAction("Clear scrollback", self._clear_history)
        m.exec(e.globalPos())

    def _normalized_sel(self):
        if not self._sel:
            return None
        a, b = sorted(self._sel, key=lambda c: (c[1], c[0]))
        return a, b

    def selected_text(self) -> str:
        s = self._normalized_sel()
        return self.model.text(*s) if s else ""

    def copy(self) -> None:
        text = self.selected_text()
        if text:
            QGuiApplication.clipboard().setText(text)

    def paste(self, text: Optional[str] = None) -> None:
        text = QGuiApplication.clipboard().text() if text is None else text
        if text:
            bracketed = (2004 << 5) in self.model.screen.mode
            self._send(bracketed_paste(text, bracketed))

    def _clear_history(self) -> None:
        self.model.screen.history.top.clear()
        self.model.scroll = 0
        self.update()
