"""Terminal emulation logic without Qt: pyte screen + scrollback, styled runs, key → bytes mapping."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

import pyte

DECCKM = 1 << 5  # pyte stores private modes shifted by 5

ANSI_DARK = {
    "black": "#1d1f28", "red": "#ff6069", "green": "#34d07f", "brown": "#ffcc00", "yellow": "#ffcc00",
    "blue": "#64a8ff", "magenta": "#c58cff", "cyan": "#4fd6e0", "white": "#d5d8e2",
    "brightblack": "#5c6170", "brightred": "#ff8a8f", "brightgreen": "#6ee7a6", "brightbrown": "#ffe066",
    "brightyellow": "#ffe066", "brightblue": "#93c2ff", "brightmagenta": "#dcb5ff", "brightcyan": "#86e9f0",
    "brightwhite": "#ffffff",
}
ANSI_LIGHT = {
    "black": "#1d1d1f", "red": "#d1242f", "green": "#1a7f37", "brown": "#9a6700", "yellow": "#9a6700",
    "blue": "#0a62d0", "magenta": "#8250df", "cyan": "#0f7b8a", "white": "#6e6e78",
    "brightblack": "#57606a", "brightred": "#e5383b", "brightgreen": "#28a745", "brightbrown": "#b07d00",
    "brightyellow": "#b07d00", "brightblue": "#007aff", "brightmagenta": "#a371f7", "brightcyan": "#1b9aaa",
    "brightwhite": "#1d1d1f",
}


@dataclass(frozen=True)
class Style:
    fg: str = "default"
    bg: str = "default"
    bold: bool = False
    italics: bool = False
    underscore: bool = False
    reverse: bool = False


def resolve_color(name: str, palette: dict, default: str, bold: bool = False) -> str:
    """pyte colour (name, 'brightX' or 6-digit hex) → '#rrggbb'."""
    if not name or name == "default":
        return default
    if len(name) == 6 and all(c in "0123456789abcdefABCDEF" for c in name):
        return "#" + name.lower()
    if bold and not name.startswith("bright") and ("bright" + name) in palette:
        name = "bright" + name
    return palette.get(name, default)


class TerminalModel:
    def __init__(self, cols: int = 80, rows: int = 24, history: int = 5000,
                 reply: Optional[Callable[[bytes], None]] = None):
        self.screen = pyte.HistoryScreen(cols, rows, history=history, ratio=0.5)
        self.stream = pyte.ByteStream(self.screen)
        self.scroll = 0  # lines scrolled back into history
        self._reply = reply
        self.screen.write_process_input = self._on_reply  # DSR / DA answers go back to the host

    def _on_reply(self, data: str) -> None:
        if self._reply:
            self._reply(data.encode("utf-8"))

    @property
    def cols(self) -> int:
        return self.screen.columns

    @property
    def rows(self) -> int:
        return self.screen.lines

    @property
    def app_cursor(self) -> bool:
        return DECCKM in self.screen.mode

    @property
    def history_len(self) -> int:
        return len(self.screen.history.top)

    def feed(self, data: bytes) -> None:
        self.stream.feed(data)
        self.scroll = 0 if self.scroll == 0 else min(self.scroll, self.history_len)

    def resize(self, cols: int, rows: int) -> bool:
        cols, rows = max(2, cols), max(2, rows)
        if cols == self.cols and rows == self.rows:
            return False
        self.screen.resize(rows, cols)
        return True

    def scroll_by(self, delta: int) -> None:
        """Positive = back into history."""
        self.scroll = max(0, min(self.history_len, self.scroll + delta))

    def _line_cells(self, line, cols: int) -> List[Tuple[str, Style]]:
        cells = []
        default = self.screen.default_char
        for x in range(cols):
            ch = line[x] if x in line else default
            cells.append((ch.data or " ", Style(ch.fg, ch.bg, ch.bold, ch.italics, ch.underscore, ch.reverse)))
        return cells

    def visible_lines(self) -> List[List[Tuple[str, Style]]]:
        cols, rows = self.cols, self.rows
        hist = list(self.screen.history.top)[len(self.screen.history.top) - self.scroll:] if self.scroll else []
        out = [self._line_cells(l, cols) for l in hist]
        for y in range(rows - len(out)):
            out.append(self._line_cells(self.screen.buffer[y], cols))
        return out[:rows]

    @staticmethod
    def runs(cells: List[Tuple[str, Style]]) -> List[Tuple[int, str, Style]]:
        """Group a line into (start column, text, style) runs."""
        out: List[Tuple[int, str, Style]] = []
        start, text, style = 0, "", None
        for x, (ch, st) in enumerate(cells):
            if st != style and text:
                out.append((start, text, style))
                start, text = x, ""
            if not text:
                start = x
            style = st
            text += ch
        if text:
            out.append((start, text, style))
        return out

    def cursor(self) -> Optional[Tuple[int, int]]:
        if self.scroll or self.screen.cursor.hidden:
            return None
        return self.screen.cursor.x, self.screen.cursor.y

    def text(self, start: Tuple[int, int], end: Tuple[int, int]) -> str:
        """Visible text between two (col, row) cells, inclusive, rows joined with newlines."""
        (c1, r1), (c2, r2) = sorted([start, end], key=lambda p: (p[1], p[0]))
        lines = self.visible_lines()
        out = []
        for r in range(r1, r2 + 1):
            if r < 0 or r >= len(lines):
                continue
            row = "".join(ch for ch, _ in lines[r])
            a = c1 if r == r1 else 0
            b = c2 + 1 if r == r2 else len(row)
            out.append(row[a:b].rstrip())
        return "\n".join(out)

    def plain_lines(self) -> List[str]:
        return ["".join(ch for ch, _ in line).rstrip() for line in self.visible_lines()]


_CSI_KEYS = {"Up": "A", "Down": "B", "Right": "C", "Left": "D", "Home": "H", "End": "F"}
_TILDE_KEYS = {"Insert": 2, "Delete": 3, "PageUp": 5, "PageDown": 6,
               "F5": 15, "F6": 17, "F7": 18, "F8": 19, "F9": 20, "F10": 21, "F11": 23, "F12": 24}
_SS3_F = {"F1": "P", "F2": "Q", "F3": "R", "F4": "S"}


def _mod_param(shift: bool, alt: bool, ctrl: bool) -> int:
    return 1 + (1 if shift else 0) + (2 if alt else 0) + (4 if ctrl else 0)


def map_key(key: Optional[str], text: str = "", *, ctrl: bool = False, alt: bool = False,
            shift: bool = False, app_cursor: bool = False) -> bytes:
    """xterm byte sequence for a key press. `key` is a name (Up, Enter, F5, …) or None for plain text."""
    mod = _mod_param(shift, alt, ctrl)
    if key in _CSI_KEYS:
        final = _CSI_KEYS[key]
        if mod > 1:
            return f"\x1b[1;{mod}{final}".encode()
        return (f"\x1bO{final}" if app_cursor else f"\x1b[{final}").encode()
    if key in _TILDE_KEYS:
        n = _TILDE_KEYS[key]
        return (f"\x1b[{n};{mod}~" if mod > 1 else f"\x1b[{n}~").encode()
    if key in _SS3_F:
        return (f"\x1b[1;{mod}{_SS3_F[key]}" if mod > 1 else f"\x1bO{_SS3_F[key]}").encode()
    if key == "Enter":
        return b"\x1b\r" if alt else b"\r"
    if key == "Backspace":
        seq = b"\x08" if ctrl else b"\x7f"
        return b"\x1b" + seq if alt else seq
    if key == "Tab":
        return b"\x1b[Z" if shift else b"\t"
    if key == "Backtab":
        return b"\x1b[Z"
    if key == "Escape":
        return b"\x1b"
    if ctrl and len(text) == 1:
        c = text.upper()
        code = None
        if "A" <= c <= "Z":
            code = ord(c) - 64
        elif c in "@ 2":
            code = 0
        elif c in "[3":
            code = 27
        elif c in "\\4":
            code = 28
        elif c in "]5":
            code = 29
        elif c in "^6":
            code = 30
        elif c in "_-/7":
            code = 31
        elif c == "8" or c == "?":
            code = 127
        if code is not None:
            seq = bytes([code])
            return b"\x1b" + seq if alt else seq
        # Qt already turned Ctrl+letter into a control char
        if len(text) == 1 and ord(text) < 32:
            return (b"\x1b" if alt else b"") + text.encode()
    if text:
        data = text.encode("utf-8")
        return b"\x1b" + data if alt else data
    return b""


def bracketed_paste(text: str, enabled: bool) -> bytes:
    data = text.replace("\r\n", "\r").replace("\n", "\r").encode("utf-8")
    return b"\x1b[200~" + data + b"\x1b[201~" if enabled else data
