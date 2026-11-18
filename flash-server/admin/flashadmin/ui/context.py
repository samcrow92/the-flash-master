"""Shared app state: profiles, the live SSH session + tunnel, and the API client."""
from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import QObject, Signal

from ..api import ApiClient
from ..profiles import Profile, ProfileStore
from .workers import run_task


class AppContext(QObject):
    changed = Signal()              # connection state / profile changed
    notice = Signal(str, str)       # kind, text (shown by the current page)
    pending_count = Signal(int)     # review badge
    theme_changed = Signal(object)  # Theme

    def __init__(self, store: ProfileStore, demo: bool = False):
        super().__init__()
        self.store = store
        self.demo = demo
        self.profile: Optional[Profile] = None
        self.session = None
        self.api: Optional[ApiClient] = None
        self.state = "disconnected"   # disconnected | connecting | connected | error
        self.server_info: dict = {}
        self.theme = None
        self.last_error = ""

    # ---------------------------------------------------------------- state
    @property
    def connected(self) -> bool:
        return self.state == "connected" and self.session is not None

    @property
    def api_ready(self) -> bool:
        return self.connected and self.api is not None and bool(self.api.token)

    def _make_session(self, profile: Profile):
        if self.demo:
            from ..demo import DemoSession

            return DemoSession(profile)
        from ..ssh import SshSession

        return SshSession(profile)

    def connect_profile(self, profile: Profile, on_done: Optional[Callable] = None) -> None:
        if self.session is not None:
            self.disconnect()
        self.profile = profile
        self.state = "connecting"
        self.last_error = ""
        self.changed.emit()

        def work():
            session = self._make_session(profile)
            session.connect()
            api = None
            info: dict = {}
            warnings = []
            if session.host_key_warning:
                warnings.append(session.host_key_warning)
            if self.demo:
                from ..demo import FakeApi

                api = FakeApi()
                info = api.health()
            else:
                if profile.use_tunnel or not profile.public_url:
                    tunnel = session.open_tunnel(int(profile.server_port or 8787))
                    base = tunnel.url
                else:
                    base = profile.public_url
                api = ApiClient(base, profile.admin_token)
                try:
                    info = api.health()
                except Exception as e:  # server not installed yet is fine
                    warnings.append(f"Server API not reachable yet ({e}). Install it from Setup & deploy.")
            return session, api, info, warnings

        def done(result):
            session, api, info, warnings = result
            self.session, self.api, self.server_info = session, api, info or {}
            self.state = "connected"
            self.store.last_used = profile.id
            try:
                self.store.save()
            except OSError:
                pass
            self.changed.emit()
            for w in warnings:
                self.notice.emit("warn", w)
            if not profile.admin_token:
                self.notice.emit("info", "No admin token saved for this profile yet. Install the server (Setup & deploy) "
                                         "or paste the token in Connections.")
            self.refresh_pending()
            if on_done:
                on_done()

        def failed(msg):
            self.state = "error"
            self.last_error = msg
            self.changed.emit()
            self.notice.emit("error", msg)

        run_task(work, done, failed)

    def disconnect(self) -> None:
        if self.session is not None:
            try:
                self.session.close()
            except Exception:
                pass
        self.session, self.api, self.server_info = None, None, {}
        self.state = "disconnected"
        self.changed.emit()
        self.pending_count.emit(0)

    def set_admin_token(self, token: str) -> None:
        if not self.profile:
            return
        self.profile.admin_token = token
        self.store.upsert(self.profile)
        self.store.save()
        if self.api is not None:
            self.api.token = token
        self.changed.emit()

    def refresh_pending(self) -> None:
        if not self.api_ready:
            return
        api = self.api
        run_task(lambda: len(api.submissions("pending")), self.pending_count.emit, lambda _m: None)
