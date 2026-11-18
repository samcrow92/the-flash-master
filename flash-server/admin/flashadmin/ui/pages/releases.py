from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QComboBox, QDialog, QDialogButtonBox, QGridLayout, QHBoxLayout, QMessageBox,
                               QPlainTextEdit, QVBoxLayout)

from ...packaging import human_size
from ..page import Page
from ..widgets import Card, Pill, button, hbox, item, label, section, short_time, table, vbox
from .. import theme as th


class PublishDialog(QDialog):
    def __init__(self, parent, version: str, notes: str = ""):
        super().__init__(parent)
        self.setWindowTitle(f"Publish {version}")
        self.setMinimumWidth(460)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(22, 20, 22, 18)
        lay.setSpacing(12)
        self.channel = QComboBox()
        self.channel.addItems(["beta", "stable"])
        self.notes = QPlainTextEdit(notes)
        self.notes.setPlaceholderText("Release notes")
        lay.addWidget(label(f"Publish {version}", "h2"))
        lay.addLayout(hbox(label("Channel", "muted"), self.channel, None))
        lay.addWidget(self.notes)
        bb = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel)
        ok = button("Publish", "primary")
        bb.addButton(ok, QDialogButtonBox.ButtonRole.AcceptRole)
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        lay.addWidget(bb)


class ReleasesPage(Page):
    title = "Releases"
    nav_label = "Releases"
    subtitle = "App update channels: publish, promote beta to stable, roll back"
    icon = "tag"
    needs = "api"

    def build(self) -> None:
        self.data = {"releases": [], "current": {}}
        self.actions.addWidget(button("Upload release folder…", "", lambda: self.go_to.emit("transfer")))
        self.actions.addWidget(button("Refresh", "", self.refresh))
        ch = QHBoxLayout()
        ch.setSpacing(16)
        self.ch_cards = {}
        for name, hint in (("stable", "what everyone gets"), ("beta", "newest of stable and beta")):
            c = Card(margins=18, spacing=4)
            v = label("–", "stat")
            c.add(hbox(label(name, "statLabel"), None, Pill(name, "green" if name == "stable" else "blue", dot=False)))
            c.add(v)
            c.add(label(f"/updates/{name}/latest.json · {hint}", "small"))
            self.ch_cards[name] = v
            ch.addWidget(c, 1)
        self.body.addLayout(ch)

        card = Card(margins=16)
        card.add(section("All releases"))
        self.table = table(["Version", "Channel", "Date", "Files", "Size", "Notes"], stretch_col=5)
        self.table.itemSelectionChanged.connect(self._sel_changed)
        card.add(self.table, 1)
        self.b_publish = button("Publish…", "primary", self._publish)
        self.b_promote = button("Promote to stable", "", self._promote)
        self.b_rollback = button("Roll back stable to this", "", self._promote)
        self.b_delete = button("Delete", "danger", self._delete)
        card.add(hbox(self.b_delete, None, self.b_rollback, self.b_promote, self.b_publish))
        self.body.addWidget(card, 1)
        self._sel_changed()

    def refresh(self) -> None:
        api = self.ctx.api
        self.task(api.releases, self._show)

    def _show(self, data) -> None:
        self.data = data
        cur = data.get("current") or {}
        for k, v in self.ch_cards.items():
            v.setText(cur.get(k) or "–")
        t = self.ctx.theme or th.DARK
        self.table.setRowCount(0)
        for r in data.get("releases") or []:
            row = self.table.rowCount()
            self.table.insertRow(row)
            channels = [c for c in ("stable", "beta") if cur.get(c) == r["version"]]
            if not r.get("published"):
                ch_text, color = "draft", t.muted
            elif channels:
                ch_text, color = "● " + " + ".join(channels), t.green if "stable" in channels else t.blue
            else:
                ch_text, color = r.get("channel") or "published", t.muted
            files = r.get("files") or []
            self.table.setItem(row, 0, item(r["version"], data=r["version"], mono=True))
            self.table.setItem(row, 1, item(ch_text, color=color))
            self.table.setItem(row, 2, item(short_time(r.get("date"))))
            self.table.setItem(row, 3, item(str(len(files))))
            self.table.setItem(row, 4, item(human_size(sum(f.get("size", 0) for f in files))))
            self.table.setItem(row, 5, item((r.get("notes") or "").replace("\n", " "), muted=True))
        self._sel_changed()

    def _selected(self):
        rows = self.table.selectionModel().selectedRows() if self.table.selectionModel() else []
        if not rows:
            return None
        ver = self.table.item(rows[0].row(), 0).data(Qt.ItemDataRole.UserRole)
        return next((r for r in self.data.get("releases", []) if r["version"] == ver), None)

    def _sel_changed(self) -> None:
        r = self._selected()
        cur = self.data.get("current") or {}
        published = bool(r and r.get("published"))
        self.b_publish.setEnabled(bool(r))
        self.b_publish.setText("Publish…" if not published else "Re-publish…")
        is_stable = bool(r and cur.get("stable") == r["version"])
        self.b_promote.setEnabled(published and not is_stable and (r or {}).get("channel") == "beta")
        self.b_rollback.setEnabled(published and not is_stable and (r or {}).get("channel") != "beta")
        self.b_delete.setEnabled(bool(r) and r["version"] not in cur.values())

    def _publish(self) -> None:
        r = self._selected()
        if not r:
            return
        dlg = PublishDialog(self, r["version"], r.get("notes") or "")
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        api, ver, chan, notes = self.ctx.api, r["version"], dlg.channel.currentText(), dlg.notes.toPlainText()
        self.task(lambda: api.publish_release(ver, chan, notes),
                  lambda _r: (self.ok(f"{ver} published to {chan}."), self.refresh()), busy=self.b_publish)

    def _promote(self) -> None:
        r = self._selected()
        if not r:
            return
        ver = r["version"]
        cur = (self.data.get("current") or {}).get("stable")
        if QMessageBox.question(self, "Stable channel", f"Point the stable channel at {ver}?\n(currently {cur or 'none'})") \
                != QMessageBox.StandardButton.Yes:
            return
        api = self.ctx.api
        self.task(lambda: api.promote_release(ver, "stable"),
                  lambda _r: (self.ok(f"stable → {ver}."), self.refresh()))

    def _delete(self) -> None:
        r = self._selected()
        if not r:
            return
        ver = r["version"]
        if QMessageBox.warning(self, "Delete release", f"Delete release {ver} and its files from the server?",
                               QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Yes,
                               QMessageBox.StandardButton.Cancel) != QMessageBox.StandardButton.Yes:
            return
        api = self.ctx.api
        self.task(lambda: api.delete_release(ver), lambda _r: (self.ok(f"Release {ver} deleted."), self.refresh()))
