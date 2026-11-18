"""Read-only code / unified diff viewer with full-width line backgrounds."""
from __future__ import annotations

from typing import List

from PySide6.QtGui import QColor, QTextCharFormat, QTextCursor, QTextFormat
from PySide6.QtWidgets import QPlainTextEdit, QTextEdit

from . import theme as th


class DiffView(QPlainTextEdit):
    def __init__(self):
        super().__init__()
        self.setObjectName("code")
        self.setReadOnly(True)
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.setFont(th.mono_font(12.5))
        self.theme = th.DARK
        self._lines: List[str] = []
        self._diff = False

    def set_theme(self, t) -> None:
        self.theme = t
        self._paint()

    def show_text(self, text: str) -> None:
        self._diff = False
        self._lines = text.splitlines()
        self.setPlainText(text)
        self._paint()

    def show_diff(self, lines: List[str]) -> None:
        self._diff = True
        self._lines = lines
        self.setPlainText("\n".join(lines) if lines else "")
        self._paint()

    def _paint(self) -> None:
        if not self._diff:
            self.setExtraSelections([])
            return
        t = self.theme
        sels = []
        doc = self.document()
        for i, line in enumerate(self._lines):
            if line.startswith("+++") or line.startswith("---"):
                color, fg = None, QColor(t.muted)
            elif line.startswith("+"):
                color, fg = QColor(t.green), None
            elif line.startswith("-"):
                color, fg = QColor(t.red), None
            elif line.startswith("@@"):
                color, fg = QColor(t.blue), QColor(t.blue)
            else:
                continue
            sel = QTextEdit.ExtraSelection()
            fmt = QTextCharFormat()
            if color is not None:
                bg = QColor(color)
                bg.setAlpha(40 if line.startswith("@@") else 46)
                fmt.setBackground(bg)
                fmt.setProperty(QTextFormat.Property.FullWidthSelection, True)
            if fg is not None:
                fmt.setForeground(fg)
            sel.format = fmt
            cur = QTextCursor(doc.findBlockByNumber(i))
            if fg is not None and color is None:
                cur.movePosition(QTextCursor.MoveOperation.EndOfBlock, QTextCursor.MoveMode.KeepAnchor)
            sel.cursor = cur
            sels.append(sel)
        self.setExtraSelections(sels)
