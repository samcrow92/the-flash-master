import pytest

pytest.importorskip("pyte")

from flashadmin.terminal import ANSI_DARK, TerminalModel, bracketed_paste, map_key, resolve_color  # noqa: E402


@pytest.mark.parametrize("args,kw,expected", [
    (("Up",), {}, b"\x1b[A"),
    (("Up",), {"app_cursor": True}, b"\x1bOA"),
    (("Left",), {"ctrl": True}, b"\x1b[1;5D"),
    (("Enter",), {}, b"\r"),
    (("Backspace",), {}, b"\x7f"),
    (("Tab",), {}, b"\t"),
    (("Tab",), {"shift": True}, b"\x1b[Z"),
    (("Delete",), {}, b"\x1b[3~"),
    (("PageUp",), {}, b"\x1b[5~"),
    (("F1",), {}, b"\x1bOP"),
    (("F5",), {}, b"\x1b[15~"),
    (("Escape",), {}, b"\x1b"),
    ((None, "c"), {"ctrl": True}, b"\x03"),
    ((None, "D"), {"ctrl": True}, b"\x04"),
    ((None, "["), {"ctrl": True}, b"\x1b"),
    ((None, " "), {"ctrl": True}, b"\x00"),
    ((None, "x"), {"alt": True}, b"\x1bx"),
    ((None, "é"), {}, "é".encode()),
    ((None, ""), {}, b""),
])
def test_map_key(args, kw, expected):
    assert map_key(*args, **kw) == expected


def test_colors_and_runs():
    m = TerminalModel(20, 3)
    m.feed(b"\x1b[31mred\x1b[0m \x1b[1;32mok\x1b[38;5;208mX")
    runs = TerminalModel.runs(m.visible_lines()[0])
    assert runs[0][:2] == (0, "red") and runs[0][2].fg == "red"
    assert runs[2][1] == "ok" and runs[2][2].bold
    assert resolve_color("red", ANSI_DARK, "#fff") == ANSI_DARK["red"]
    assert resolve_color("green", ANSI_DARK, "#fff", bold=True) == ANSI_DARK["brightgreen"]
    assert resolve_color("ff8700", ANSI_DARK, "#fff") == "#ff8700"
    assert resolve_color("default", ANSI_DARK, "#abc") == "#abc"


def test_scrollback_cursor_and_text():
    m = TerminalModel(10, 3)
    m.feed(b"l1\r\nl2\r\nl3\r\nl4\r\nl5")
    assert m.plain_lines() == ["l3", "l4", "l5"]
    assert m.cursor() == (2, 2)
    m.scroll_by(2)
    assert m.plain_lines() == ["l1", "l2", "l3"] and m.cursor() is None
    m.scroll_by(99)
    assert m.scroll == 2
    m.scroll_by(-5)
    assert m.text((0, 1), (1, 2)) == "l4\nl5"


def test_resize_and_modes_and_reply():
    sent = []
    m = TerminalModel(10, 3, reply=sent.append)
    assert m.resize(40, 12) and (m.cols, m.rows) == (40, 12)
    assert not m.resize(40, 12)
    m.feed(b"\x1b[?1h")
    assert m.app_cursor
    m.feed(b"\x1b[6n")  # cursor position report
    assert sent and sent[-1].startswith(b"\x1b[")


def test_bracketed_paste():
    assert bracketed_paste("a\nb", False) == b"a\rb"
    assert bracketed_paste("a", True) == b"\x1b[200~a\x1b[201~"
