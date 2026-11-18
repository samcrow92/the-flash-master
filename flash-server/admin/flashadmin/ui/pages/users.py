from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QComboBox, QLineEdit, QMessageBox, QPlainTextEdit

from ...model import user_note
from ..page import Page
from ..widgets import Card, Pill, ago, button, hbox, item, label, section, short_time, table, vbox
from .. import theme as th


class UsersPage(Page):
    title = "Users"
    nav_label = "Users"
    subtitle = "Who can reach the server, and with which token"
    icon = "users"
    needs = "api"

    def build(self) -> None:
        self.users = []
        self.actions.addWidget(button("Refresh", "", self.refresh))
        new = Card(margins=16, spacing=10)
        self.n_name = QLineEdit()
        self.n_name.setPlaceholderText("name, e.g. ana")
        self.n_name.returnPressed.connect(self._create)
        self.n_role = QComboBox()
        self.n_role.addItems(["user", "admin"])
        self.b_create = button("Create user", "primary", self._create)
        new.add(hbox(section("New user"), 12, self.n_name, self.n_role, self.b_create, spacing=10))
        self.body.addWidget(new)

        # one-time token reveal
        self.reveal = Card(margins=18, spacing=10)
        self.reveal.setProperty("selected", True)
        self.r_title = label("", "h2")
        self.r_token = label("", "token", selectable=True)
        self.r_token.setFont(th.mono_font(14))
        self.r_note = QPlainTextEdit()
        self.r_note.setReadOnly(True)
        self.r_note.setFixedHeight(118)
        self.reveal.add(hbox(self.r_title, None, label("Shown once — copy it now", "small"),
                             button("✕", "ghost", self.reveal.hide)))
        self.reveal.add(hbox(self.r_token, None, button("Copy token", "", lambda: self._copy(self._token)), spacing=10))
        self.reveal.add(self.r_note)
        self.reveal.add(hbox(label("Send this note to the user (chat, mail). It has everything the app needs.", "small"),
                             None, button("Copy note", "primary", lambda: self._copy(self.r_note.toPlainText()))))
        self.reveal.hide()
        self.body.addWidget(self.reveal)
        self._token = ""

        card = Card(margins=16)
        card.add(section("Accounts"))
        self.table = table(["Name", "Role", "Status", "Created", "Last seen", ""], stretch_col=5)
        self.table.itemSelectionChanged.connect(self._sel_changed)
        card.add(self.table, 1)
        self.b_rotate = button("Rotate token", "", self._rotate)
        self.b_disable = button("Disable", "", self._toggle_disabled)
        self.b_admin = button("Make admin", "", self._toggle_admin)
        self.b_delete = button("Delete", "danger", self._delete)
        card.add(hbox(self.b_delete, None, self.b_admin, self.b_disable, self.b_rotate))
        self.body.addWidget(card, 1)
        self._sel_changed()

    def refresh(self) -> None:
        api = self.ctx.api
        self.task(api.users, self._show)

    def _show(self, users) -> None:
        self.users = users
        t = self.ctx.theme or th.DARK
        keep = self._selected()
        self.table.setRowCount(0)
        for u in users:
            r = self.table.rowCount()
            self.table.insertRow(r)
            self.table.setItem(r, 0, item(u["name"], data=u["id"]))
            self.table.setItem(r, 1, item(u["role"], color=t.accent if (u["role"] == "admin" and t.dark) else
                                          (t.accent2 if u["role"] == "admin" else "")))
            self.table.setItem(r, 2, item("disabled" if u.get("disabled") else "● active",
                                          color=t.red if u.get("disabled") else t.green))
            self.table.setItem(r, 3, item(short_time(u.get("createdAt")), muted=True))
            self.table.setItem(r, 4, item(ago(u.get("lastSeenAt"))))
            if keep and keep["id"] == u["id"]:
                self.table.selectRow(r)
        self._sel_changed()

    def _selected(self):
        sm = self.table.selectionModel()
        rows = sm.selectedRows() if sm else []
        if not rows:
            return None
        uid = self.table.item(rows[0].row(), 0).data(Qt.ItemDataRole.UserRole)
        return next((u for u in self.users if u["id"] == uid), None)

    def _sel_changed(self) -> None:
        u = self._selected()
        for b in (self.b_rotate, self.b_disable, self.b_admin, self.b_delete):
            b.setEnabled(bool(u))
        if u:
            self.b_disable.setText("Enable" if u.get("disabled") else "Disable")
            self.b_admin.setText("Make user" if u["role"] == "admin" else "Make admin")

    def _show_token(self, title: str, name: str, token: str) -> None:
        self._token = token
        url = self.ctx.profile.client_url() if self.ctx.profile else ""
        self.r_title.setText(title)
        self.r_token.setText(token)
        self.r_note.setPlainText(user_note(url or "<server URL>", token, name))
        self.reveal.show()

    def _copy(self, text: str) -> None:
        QGuiApplication.clipboard().setText(text)
        self.ok("Copied to the clipboard.")

    def _create(self) -> None:
        name = self.n_name.text().strip()
        if not name:
            self.error("Enter a name for the new user.")
            return
        api, role = self.ctx.api, self.n_role.currentText()

        def done(res):
            self.n_name.clear()
            self._show_token(f"Token for {res['user']['name']}", res["user"]["name"], res["token"])
            self.refresh()

        self.task(lambda: api.create_user(name, role), done, busy=self.b_create)

    def _rotate(self) -> None:
        u = self._selected()
        if not u:
            return
        if QMessageBox.question(self, "Rotate token", f"Issue a new token for {u['name']}? The old one stops working now.") \
                != QMessageBox.StandardButton.Yes:
            return
        api = self.ctx.api
        self.task(lambda: api.rotate_token(u["id"]),
                  lambda tok: self._show_token(f"New token for {u['name']}", u["name"], tok))

    def _toggle_disabled(self) -> None:
        u = self._selected()
        if not u:
            return
        api, val = self.ctx.api, not u.get("disabled")
        self.task(lambda: api.update_user(u["id"], disabled=val),
                  lambda _r: (self.ok(f"{u['name']} {'disabled' if val else 'enabled'}."), self.refresh()))

    def _toggle_admin(self) -> None:
        u = self._selected()
        if not u:
            return
        role = "user" if u["role"] == "admin" else "admin"
        api = self.ctx.api
        self.task(lambda: api.update_user(u["id"], role=role),
                  lambda _r: (self.ok(f"{u['name']} is now {role}."), self.refresh()))

    def _delete(self) -> None:
        u = self._selected()
        if not u:
            return
        if QMessageBox.warning(self, "Delete user", f"Delete {u['name']}? Their token stops working; submissions stay.",
                               QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Yes,
                               QMessageBox.StandardButton.Cancel) != QMessageBox.StandardButton.Yes:
            return
        api = self.ctx.api
        self.task(lambda: api.delete_user(u["id"]), lambda _r: (self.ok(f"{u['name']} deleted."), self.refresh()))
