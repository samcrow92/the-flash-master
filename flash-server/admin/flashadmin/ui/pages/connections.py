from __future__ import annotations

import copy

from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import (QButtonGroup, QCheckBox, QFileDialog, QGridLayout, QHBoxLayout, QLineEdit,
                               QListWidget, QListWidgetItem, QMessageBox, QPushButton, QSpinBox, QWidget)

from ...profiles import Profile
from ..page import Page
from ..widgets import Card, Pill, button, hbox, label, section, vbox


class ConnectionsPage(Page):
    title = "Connections"
    nav_label = "Connections"
    subtitle = "Saved servers you reach over SSH"
    icon = "plug"
    needs = None

    def build(self) -> None:
        self.editing: Profile | None = None
        self.actions.addWidget(button("New profile", "", self._new))
        row = QHBoxLayout()
        row.setSpacing(16)

        left = Card(margins=14)
        left.setFixedWidth(300)
        left.add(section("Profiles"))
        self.list = QListWidget()
        self.list.setSpacing(2)
        self.list.currentRowChanged.connect(self._select)
        left.add(self.list, 1)
        self.secret_note = label("", "small", wrap=True)
        left.add(self.secret_note)
        row.addWidget(left)

        right = QWidget()
        rl = vbox(spacing=16)
        right.setLayout(rl)

        ssh = Card()
        self.status_pill = Pill("disconnected")
        ssh.add(hbox(section("SSH"), None, self.status_pill))
        g = QGridLayout()
        g.setHorizontalSpacing(14)
        g.setVerticalSpacing(12)
        self.f_name = QLineEdit()
        self.f_host = QLineEdit()
        self.f_host.setPlaceholderText("server.lan or 10.0.0.5")
        self.f_port = QSpinBox()
        self.f_port.setRange(1, 65535)
        self.f_user = QLineEdit()
        self.f_user.setPlaceholderText("ubuntu")
        self.auth_key = button("Key file", "seg")
        self.auth_pw = button("Password", "seg")
        for b in (self.auth_key, self.auth_pw):
            b.setCheckable(True)
        grp = QButtonGroup(self)
        grp.addButton(self.auth_key)
        grp.addButton(self.auth_pw)
        self.auth_key.toggled.connect(self._auth_changed)
        self.f_key = QLineEdit()
        self.f_key.setPlaceholderText("~/.ssh/id_ed25519 (empty = agent / default keys)")
        self.key_browse = button("Browse…", "", self._browse_key)
        self.f_password = QLineEdit()
        self.f_password.setEchoMode(QLineEdit.EchoMode.Password)
        self.pw_label = label("Password", "muted")
        self.f_sudo_same = QCheckBox("sudo uses the same password")
        self.f_sudo_same.toggled.connect(lambda on: self.f_sudo_pw.setEnabled(not on))
        self.f_sudo_pw = QLineEdit()
        self.f_sudo_pw.setEchoMode(QLineEdit.EchoMode.Password)
        self.f_sudo_pw.setPlaceholderText("empty = passwordless sudo")

        def lab(t):
            lb = label(t, "muted")
            lb.setMinimumWidth(92)
            return lb

        g.addWidget(lab("Name"), 0, 0)
        g.addWidget(self.f_name, 0, 1, 1, 3)
        g.addWidget(lab("Host"), 1, 0)
        g.addWidget(self.f_host, 1, 1)
        g.addWidget(lab("Port"), 1, 2)
        g.addWidget(self.f_port, 1, 3)
        g.addWidget(lab("User"), 2, 0)
        g.addWidget(self.f_user, 2, 1)
        g.addWidget(lab("Sign in with"), 2, 2)
        g.addLayout(hbox(self.auth_key, self.auth_pw, None, spacing=4), 2, 3)
        g.addWidget(lab("Key file"), 3, 0)
        g.addLayout(hbox(self.f_key, self.key_browse, spacing=8), 3, 1, 1, 3)
        g.addWidget(self.pw_label, 4, 0)
        g.addWidget(self.f_password, 4, 1)
        g.addWidget(self.f_sudo_same, 4, 2, 1, 2)
        g.addWidget(lab("sudo password"), 5, 0)
        g.addWidget(self.f_sudo_pw, 5, 1)
        g.setColumnStretch(1, 3)
        g.setColumnStretch(3, 2)
        ssh.add(g)
        self.hostkey_note = label("Host keys are checked: the first connection remembers the key, a changed key is refused.",
                                  "small", wrap=True)
        ssh.add(self.hostkey_note)
        rl.addWidget(ssh)

        srv = Card()
        srv.add(section("Flash server"))
        g2 = QGridLayout()
        g2.setHorizontalSpacing(14)
        g2.setVerticalSpacing(12)
        self.f_sport = QSpinBox()
        self.f_sport.setRange(1, 65535)
        self.f_url = QLineEdit()
        self.f_url.setPlaceholderText("https://flash.example.com — what users paste in the app")
        self.f_tunnel = QCheckBox("Reach the admin API through an SSH tunnel (recommended)")
        self.f_token = QLineEdit()
        self.f_token.setEchoMode(QLineEdit.EchoMode.Password)
        self.f_token.setPlaceholderText("filled in automatically after Install")
        show = button("Show", "ghost")
        show.setCheckable(True)
        show.toggled.connect(lambda on: self.f_token.setEchoMode(QLineEdit.EchoMode.Normal if on else QLineEdit.EchoMode.Password))
        g2.addWidget(lab("HTTP port"), 0, 0)
        g2.addWidget(self.f_sport, 0, 1)
        g2.addWidget(lab("Public URL"), 0, 2)
        g2.addWidget(self.f_url, 0, 3)
        g2.addWidget(lab("Admin token"), 1, 0)
        g2.addLayout(hbox(self.f_token, show, spacing=6), 1, 1, 1, 3)
        g2.addWidget(self.f_tunnel, 2, 1, 1, 3)
        g2.setColumnStretch(1, 1)
        g2.setColumnStretch(3, 3)
        srv.add(g2)
        rl.addWidget(srv)

        self.save_btn = button("Save", "", self._save)
        self.delete_btn = button("Delete", "danger", self._delete)
        self.connect_btn = button("Connect", "primary", self._toggle_connect)
        self.connect_btn.setMinimumWidth(130)
        rl.addLayout(hbox(self.delete_btn, None, self.save_btn, self.connect_btn))
        rl.addStretch(1)
        row.addWidget(right, 1)
        self.body.addLayout(row, 1)
        self._reload_list()

    # ----------------------------------------------------------------- list
    def _reload_list(self, select_id: str = "") -> None:
        store = self.ctx.store
        self.list.blockSignals(True)
        self.list.clear()
        for p in store.profiles:
            it = QListWidgetItem(f"{p.name}\n{p.display_target() or 'not configured'}")
            it.setData(Qt.ItemDataRole.UserRole, p.id)
            it.setSizeHint(QSize(0, 56))
            self.list.addItem(it)
        self.list.blockSignals(False)
        self.secret_note.setText(
            "⚠  The 'keyring' package is not available: passwords and tokens are stored in plain text in "
            f"{store.path} (chmod 600). Install keyring to use the OS secret store." if store.secrets_in_file
            else "Passwords and tokens are kept in the system keychain.")
        ids = [p.id for p in store.profiles]
        target = select_id or (self.ctx.profile.id if self.ctx.profile else "") or store.last_used
        idx = ids.index(target) if target in ids else (0 if ids else -1)
        if idx >= 0:
            self.list.setCurrentRow(idx)
            self._select(idx)
        else:
            self._new()

    def _select(self, row: int) -> None:
        if row < 0 or row >= len(self.ctx.store.profiles):
            return
        self._load(copy.copy(self.ctx.store.profiles[row]))

    def _load(self, p: Profile) -> None:
        self.editing = p
        self.f_name.setText(p.name)
        self.f_host.setText(p.host)
        self.f_port.setValue(int(p.port or 22))
        self.f_user.setText(p.user)
        (self.auth_pw if p.auth == "password" else self.auth_key).setChecked(True)
        self.f_key.setText(p.key_file)
        self.f_password.setText(p.password)
        self.f_sudo_same.setChecked(p.sudo_same_password)
        self.f_sudo_pw.setText(p.sudo_password)
        self.f_sudo_pw.setEnabled(not p.sudo_same_password)
        self.f_sport.setValue(int(p.server_port or 8787))
        self.f_url.setText(p.public_url)
        self.f_tunnel.setChecked(p.use_tunnel)
        self.f_token.setText(p.admin_token)
        self._auth_changed()
        self.connection_changed()

    def _form(self) -> Profile:
        p = copy.copy(self.editing) if self.editing else Profile()
        p.name = self.f_name.text().strip() or self.f_host.text().strip() or "Server"
        p.host = self.f_host.text().strip()
        p.port = self.f_port.value()
        p.user = self.f_user.text().strip()
        p.auth = "password" if self.auth_pw.isChecked() else "key"
        p.key_file = self.f_key.text().strip()
        p.password = self.f_password.text()
        p.sudo_same_password = self.f_sudo_same.isChecked()
        p.sudo_password = self.f_sudo_pw.text()
        p.server_port = self.f_sport.value()
        p.public_url = self.f_url.text().strip()
        p.use_tunnel = self.f_tunnel.isChecked()
        p.admin_token = self.f_token.text().strip()
        return p

    def _auth_changed(self, *_a) -> None:
        key = self.auth_key.isChecked()
        self.f_key.setEnabled(key)
        self.key_browse.setEnabled(key)
        self.pw_label.setText("Passphrase" if key else "Password")
        self.f_password.setPlaceholderText("key passphrase / sudo password (optional)" if key else "SSH password")

    def _browse_key(self) -> None:
        import os

        path, _ = QFileDialog.getOpenFileName(self, "SSH private key", os.path.expanduser("~/.ssh"))
        if path:
            self.f_key.setText(path)

    # -------------------------------------------------------------- actions
    def _new(self) -> None:
        self.list.clearSelection()
        self._load(Profile())

    def _save(self) -> Profile | None:
        p = self._form()
        if not p.host:
            self.error("Host is required.")
            return None
        self.ctx.store.upsert(p)
        try:
            self.ctx.store.save()
        except OSError as e:
            self.error(f"Cannot save profiles: {e}")
            return None
        if self.ctx.profile and self.ctx.profile.id == p.id:
            self.ctx.profile = p
            if self.ctx.api is not None:
                self.ctx.api.token = p.admin_token
            self.ctx.changed.emit()
        self.editing = p
        self._reload_list(p.id)
        self.ok(f"Saved “{p.name}”.")
        return p

    def _delete(self) -> None:
        if not self.editing or not self.ctx.store.get(self.editing.id):
            return
        if QMessageBox.question(self, "Delete profile", f"Delete the profile “{self.editing.name}” and its saved secrets?") \
                != QMessageBox.StandardButton.Yes:
            return
        if self.ctx.profile and self.ctx.profile.id == self.editing.id:
            self.ctx.disconnect()
            self.ctx.profile = None
        self.ctx.store.remove(self.editing.id)
        self.ctx.store.save()
        self._reload_list()

    def _toggle_connect(self) -> None:
        if self.ctx.connected or self.ctx.state == "connecting":
            if self.ctx.profile and self.editing and self.ctx.profile.id == self.editing.id:
                self.ctx.disconnect()
                return
        p = self._save()
        if p:
            self.ctx.connect_profile(p, lambda: self.ok(f"Connected to {p.display_target()}."))

    def connection_changed(self) -> None:
        if not hasattr(self, "connect_btn"):
            return
        mine = bool(self.ctx.profile and self.editing and self.ctx.profile.id == self.editing.id)
        state = self.ctx.state if mine else "disconnected"
        self.status_pill.set(state)
        self.connect_btn.setText({"connected": "Disconnect", "connecting": "Cancel"}.get(state, "Connect"))
        if mine and self.ctx.session is not None and getattr(self.ctx.session, "host_key_warning", None):
            self.hostkey_note.setText("⚠  " + self.ctx.session.host_key_warning)
