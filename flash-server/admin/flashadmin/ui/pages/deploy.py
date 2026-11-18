from __future__ import annotations

import json
import os

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QCheckBox, QFileDialog, QHBoxLayout, QLineEdit, QPlainTextEdit, QProgressBar,
                               QSpinBox, QTabWidget, QWidget)

from ... import ops, packaging, remote
from ..page import Page
from ..widgets import Card, LogView, Pill, button, hbox, item, label, section, table, vbox
from .. import theme as th


class DeployPage(Page):
    title = "Setup & deploy"
    nav_label = "Setup && deploy"
    subtitle = "Install or update the server, control the service, read logs, edit its config"
    icon = "rocket"
    needs = "ssh"

    def build(self) -> None:
        self._journal = None
        top = QHBoxLayout()
        top.setSpacing(16)

        inst = Card()
        inst.add(section("Install / update"))
        self.src = QLineEdit(packaging.find_flash_server_root() or "")
        self.src.setPlaceholderText("folder with server/ and deploy/install.sh")
        inst.add(hbox(label("Source", "muted"), self.src, button("Browse…", "", self._browse), spacing=10))
        self.o_public = QCheckBox("Listen on all interfaces (--host 0.0.0.0)")
        self.o_port = QSpinBox()
        self.o_port.setRange(1, 65535)
        self.o_port.setValue(8787)
        self.o_fw = QCheckBox("Open the firewall port (ufw)")
        inst.add(hbox(self.o_public, 18, self.o_fw, None))
        inst.add(hbox(label("HTTP port", "muted"), self.o_port, None))
        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.hide()
        inst.add(self.progress)
        inst.lay.addStretch(1)
        self.install_btn = button("Install / Update server", "primary", self._install)
        inst.add(hbox(label("Packs the code, uploads it over SFTP and runs install.sh with sudo.", "small"),
                      None, self.install_btn))
        top.addWidget(inst, 3)

        svc = Card()
        svc.add(section("Service"))
        self.svc_pill = Pill("unknown")
        svc.add(hbox(label("flash-server", "h2"), None, self.svc_pill))
        self.svc_detail = label("–", "muted", wrap=True)
        svc.add(self.svc_detail)
        svc.lay.addStretch(1)
        self.b_start = button("Start", "", lambda: self._svc("start"))
        self.b_stop = button("Stop", "", lambda: self._svc("stop"))
        self.b_restart = button("Restart", "", lambda: self._svc("restart"))
        svc.add(hbox(self.b_start, self.b_stop, self.b_restart, None, spacing=8))
        self.b_prereq = button("Check prerequisites", "ghost", self._prereqs)
        svc.add(hbox(self.b_prereq, None))
        top.addWidget(svc, 2)
        self.body.addLayout(top)

        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        # output
        self.out = LogView()
        self.tabs.addTab(self._wrap(self.out), "Install output")
        # live logs
        logs = QWidget()
        self.follow_btn = button("Follow", "", self._toggle_follow)
        self.follow_btn.setCheckable(True)
        self.journal = LogView()
        self.journal.setPlaceholderText("journalctl -u flash-server appears here.")
        logs.setLayout(vbox(hbox(label("journalctl -u flash-server -f", "small"), None,
                                 button("Load last 200", "ghost", self._journal_once),
                                 button("Clear", "ghost", self.journal.clear), self.follow_btn, spacing=6),
                            self.journal, spacing=8, margins=(0, 10, 0, 0)))
        self.tabs.addTab(logs, "Live logs")
        # config
        cfg = QWidget()
        self.cfg = QPlainTextEdit()
        self.cfg.setObjectName("code")
        self.cfg.setFont(th.mono_font(12.5))
        self.cfg.setPlaceholderText(f"Load {remote.CONFIG} to edit it.")
        self.cfg_save = button("Save", "", lambda: self._save_cfg(False))
        self.cfg_save_restart = button("Save && restart", "primary", lambda: self._save_cfg(True))
        cfg.setLayout(vbox(hbox(label(remote.CONFIG, "small"), None, button("Reload", "ghost", self._load_cfg),
                                self.cfg_save, self.cfg_save_restart, spacing=6),
                           self.cfg, spacing=8, margins=(0, 10, 0, 0)))
        self.tabs.addTab(cfg, "Config")
        # prereqs
        self.pre_table = table(["Check", "Result", "Value", "Hint"], stretch_col=3)
        self.tabs.addTab(self._wrap(self.pre_table), "Prerequisites")
        self.body.addWidget(self.tabs, 1)

    @staticmethod
    def _wrap(w) -> QWidget:
        box = QWidget()
        box.setLayout(vbox(w, margins=(0, 10, 0, 0)))
        return box

    def refresh(self) -> None:
        p = self.ctx.profile
        if p:
            self.o_port.setValue(int(p.server_port or 8787))
            self.o_public.setChecked(p.bind_public)
            self.o_fw.setChecked(p.open_firewall)
        session = self.ctx.session
        self.task(lambda: ops.service_status(session), self._show_status)
        if not self.cfg.toPlainText():
            self._load_cfg(quiet=True)

    def connection_changed(self) -> None:
        if not self.ctx.connected and self._journal is not None:
            self._stop_follow()

    # ------------------------------------------------------------- service
    def _show_status(self, st: dict) -> None:
        active = st.get("active", "unknown")
        self.svc_pill.set("running" if active == "active" else active,
                          {"active": "green", "failed": "red", "activating": "amber"}.get(active, "muted"))
        if st.get("loaded") == "not-found":
            self.svc_detail.setText("Not installed yet. Run Install / Update server.")
        else:
            bits = [b for b in (st.get("sub"), f"PID {st['pid']}" if st.get("pid") not in ("", "0", None) else "",
                                f"since {st['since']}" if st.get("since") else "") if b]
            self.svc_detail.setText(" · ".join(bits) or "–")

    def _svc(self, action: str) -> None:
        session = self.ctx.session
        self.task(lambda: ops.service_action(session, action),
                  lambda st: (self._show_status(st), self.ok(f"systemctl {action} flash-server: done.")),
                  busy={"start": self.b_start, "stop": self.b_stop, "restart": self.b_restart}[action])

    def _prereqs(self) -> None:
        session = self.ctx.session
        self.tabs.setCurrentIndex(3)
        self.task(lambda: ops.check_prereqs(session), self._show_prereqs, busy=self.b_prereq)

    def _show_prereqs(self, checks) -> None:
        t = self.ctx.theme
        self.pre_table.setRowCount(0)
        for c in checks:
            r = self.pre_table.rowCount()
            self.pre_table.insertRow(r)
            ok = c["ok"]
            mark, color = ("✓  ok", t.green) if ok else (("–  n/a", t.muted) if ok is None else ("✕  fail", t.red))
            value = c["value"]
            if isinstance(value, int) and "disk" in c["name"].lower():
                value = packaging.human_size(value) if value >= 0 else "?"
            self.pre_table.setItem(r, 0, item(c["name"]))
            self.pre_table.setItem(r, 1, item(mark, color=color))
            self.pre_table.setItem(r, 2, item(value, mono=True))
            self.pre_table.setItem(r, 3, item(c.get("hint", ""), muted=True))
        bad = [c["name"] for c in checks if c["ok"] is False]
        if bad:
            self.show_banner("warn", "Prerequisites missing: " + ", ".join(bad))
        else:
            self.ok("All prerequisites are met.")

    # ------------------------------------------------------------- install
    def _browse(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "flash-server folder (with server/ and deploy/)", self.src.text())
        if d:
            self.src.setText(d)

    def _install(self) -> None:
        root = self.src.text().strip()
        if not packaging.is_flash_server_root(root):
            self.error(f"“{root or '(empty)'}” does not contain server/ and deploy/install.sh. Pick the flash-server folder.")
            return
        p = self.ctx.profile
        p.bind_public, p.open_firewall, p.server_port = self.o_public.isChecked(), self.o_fw.isChecked(), self.o_port.value()
        self.ctx.store.upsert(p)
        try:
            self.ctx.store.save()
        except OSError:
            pass
        session = self.ctx.session
        self.tabs.setCurrentIndex(0)
        self.out.clear()
        self.progress.setValue(0)
        self.progress.show()
        port, public, fw = p.server_port, p.bind_public, p.open_firewall

        def work(progress):
            return ops.install_server(session, root, port=port, bind_public=public, open_firewall=fw,
                                      on_line=lambda l: progress(("line", l)),
                                      progress=lambda a, b: progress(("bytes", a, b)))

        def on_progress(ev):
            if ev[0] == "line":
                self.out.append_line(ev[1])
            else:
                self.progress.setValue(int(ev[1] * 100 / max(1, ev[2])))

        def done(result: dict):
            token = result.get("adminToken")
            if token:
                self.ctx.set_admin_token(token)
                self.ok("Server installed. The admin token was saved to this profile.")
            else:
                self.ok("Server updated." + (" (no new admin token: the existing one stays valid)" if result else ""))
            self.out.append_line("» done")
            self._reconnect_api()
            self.refresh()

        self.task(work, done, busy=self.install_btn, progress=on_progress,
                  finished=lambda: self.progress.hide())

    def _reconnect_api(self) -> None:
        """After a first install the tunnel target may have just come alive: re-read health."""
        api = self.ctx.api
        if api is None:
            return

        def work():
            return api.health()

        def done(info):
            self.ctx.server_info = info or {}
            self.ctx.changed.emit()

        self.task(work, done, error=lambda _m: None)

    # ---------------------------------------------------------------- logs
    def _journal_once(self) -> None:
        session = self.ctx.session
        self.task(lambda: session.exec(remote.journal_command(200, follow=False), sudo=True)[1],
                  lambda out: (self.journal.clear(), [self.journal.append_line(l) for l in out.splitlines()]))

    def _toggle_follow(self) -> None:
        if self.follow_btn.isChecked():
            self._start_follow()
        else:
            self._stop_follow()

    def _start_follow(self) -> None:
        from ...ssh import Running

        session = self.ctx.session
        running = Running()
        self._journal = running
        self.follow_btn.setText("Stop")

        def work(progress):
            session.exec(remote.journal_command(100, follow=True), sudo=True, running=running, on_line=progress)

        self.task(work, None, progress=self.journal.append_line, finished=self._follow_ended,
                  error=lambda m: None if running.cancelled else self.error(m))

    def _follow_ended(self) -> None:
        self._journal = None
        self.follow_btn.setChecked(False)
        self.follow_btn.setText("Follow")

    def _stop_follow(self) -> None:
        if self._journal is not None:
            self._journal.cancel()

    # -------------------------------------------------------------- config
    def _load_cfg(self, quiet: bool = False) -> None:
        session = self.ctx.session
        self.task(lambda: ops.read_config(session), self.cfg.setPlainText,
                  error=(lambda _m: None) if quiet else None)

    def _save_cfg(self, restart: bool) -> None:
        text = self.cfg.toPlainText()
        try:
            json.loads(text)
        except ValueError as e:
            self.error(f"Config is not valid JSON: {e}")
            return
        session = self.ctx.session

        def work():
            ops.write_config(session, text)
            return ops.service_action(session, "restart") if restart else None

        def done(st):
            if st:
                self._show_status(st)
            self.ok("Config saved" + (" and service restarted." if restart else ". Restart the service to apply it."))

        self.task(work, done, busy=self.cfg_save_restart if restart else self.cfg_save)
