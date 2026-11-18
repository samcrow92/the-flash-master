import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6.QtWidgets")
pytest.importorskip("pyte")


@pytest.fixture(scope="module")
def win(tmp_path_factory):
    os.environ["FLASH_ADMIN_HOME"] = str(tmp_path_factory.mktemp("home"))
    from flashadmin.app import build_window
    from flashadmin.ui.workers import wait_idle

    app, ctx, w = build_window(demo=True, theme="dark")
    w.resize(1440, 900)
    w.show()
    ctx.connect_profile(ctx.store.profiles[0])
    wait_idle(app)
    yield app, ctx, w
    w.close()


def test_every_page_renders(win):
    from flashadmin.ui.workers import wait_idle

    app, ctx, w = win
    assert ctx.state == "connected"
    for key in w.pages:
        w.navigate(key)
        wait_idle(app)
        assert w.stack.currentWidget() is w.pages[key]
        assert not w.pages[key].banner.isVisible() or w.pages[key].banner.property("kind") != "error", key
        assert not w.grab().isNull()


def test_review_queue_and_badge(win):
    from flashadmin.ui.workers import wait_idle

    app, ctx, w = win
    w.navigate("review")
    wait_idle(app)
    page = w.pages["review"]
    assert page.list.count() == 2
    assert page.ch_files.count() == 4  # diff files of the demo submission
    assert w.nav["review"].badge.text() == "2"
    page._decide("reject")  # no feedback -> inline error, no API call
    assert page.banner.property("kind") == "error"


def test_theme_switch(win):
    app, ctx, w = win
    w.theme_mode = "light"
    w.apply_theme()
    assert ctx.theme.name == "light"
    w.theme_mode = "dark"
    w.apply_theme()


def test_terminal_keys_go_to_shell(win):
    from PySide6.QtCore import Qt
    from PySide6.QtGui import QKeyEvent
    from PySide6.QtWidgets import QApplication

    from flashadmin.ui.terminal_widget import TerminalWidget

    class Shell:
        sent = []

        def send(self, d):
            self.sent.append(d)

        def resize(self, c, r):
            pass

        def recv(self, timeout=0.2):
            import time

            time.sleep(timeout)
            return b""

        def close(self):
            pass

    t = TerminalWidget()
    sh = Shell()
    t.attach(sh)
    QApplication.sendEvent(t, QKeyEvent(QKeyEvent.Type.KeyPress, Qt.Key.Key_Up, Qt.KeyboardModifier.NoModifier))
    QApplication.sendEvent(t, QKeyEvent(QKeyEvent.Type.KeyPress, Qt.Key.Key_A, Qt.KeyboardModifier.NoModifier, "a"))
    t.close_shell()
    assert sh.sent[:2] == [b"\x1b[A", b"a"]
    t.feed(b"\x1b[32mhello\x1b[0m")
    assert t.model.plain_lines()[0] == "hello"
    t.resize(800, 400)
    assert t.model.cols > 50
