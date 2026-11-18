from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QHeaderView, QMessageBox, QTreeWidget, QTreeWidgetItem

from ..page import Page
from ..widgets import Card, button, hbox, label, section, short_time
from .. import theme as th


class MarketplacePage(Page):
    title = "Marketplace"
    nav_label = "Marketplace"
    subtitle = "Published plugins and their versions"
    icon = "store"
    needs = "api"

    def build(self) -> None:
        self.actions.addWidget(button("Refresh", "", self.refresh))
        card = Card(margins=16)
        self.count = label("", "small")
        card.add(hbox(section("Published"), None, self.count))
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Plugin / version", "Name", "Owner", "Published", "SHA-256"])
        self.tree.setRootIsDecorated(True)
        self.tree.setIndentation(18)
        self.tree.setUniformRowHeights(True)
        h = self.tree.header()
        h.setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        h.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        h.setStretchLastSection(False)
        self.tree.itemSelectionChanged.connect(self._sel_changed)
        card.add(self.tree, 1)
        self.b_ver = button("Unpublish version", "", self._unpublish_version)
        self.b_plugin = button("Unpublish plugin", "danger", self._unpublish_plugin)
        card.add(hbox(label("Unpublishing removes the package from index.json; installed copies stay on users' machines.",
                            "small"), None, self.b_ver, self.b_plugin))
        self.body.addWidget(card, 1)
        self._sel_changed()

    def refresh(self) -> None:
        api = self.ctx.api
        self.task(api.plugins, self._show)

    def _show(self, plugins) -> None:
        self.tree.clear()
        t = self.ctx.theme or th.DARK
        mono = th.mono_font(12)
        nver = 0
        for p in sorted(plugins, key=lambda x: x["id"]):
            top = QTreeWidgetItem([p["id"], p.get("name", ""), p.get("owner", ""), "", f"latest {p.get('latest', '')}"])
            top.setData(0, Qt.ItemDataRole.UserRole, (p["id"], None))
            f = top.font(0)
            f.setBold(True)
            top.setFont(0, f)
            top.setForeground(4, QColor(t.muted))
            for v in p.get("versions") or []:
                nver += 1
                child = QTreeWidgetItem([v["version"], "", "", short_time(v.get("publishedAt")), (v.get("sha256") or "")[:16]])
                child.setData(0, Qt.ItemDataRole.UserRole, (p["id"], v["version"]))
                child.setFont(4, mono)
                child.setForeground(4, QColor(t.muted))
                if v["version"] == p.get("latest"):
                    child.setForeground(0, QColor(t.accent if t.dark else t.accent2))
                top.addChild(child)
            self.tree.addTopLevelItem(top)
            top.setExpanded(True)
        self.count.setText(f"{len(plugins)} plugins · {nver} versions")

    def _selected(self):
        items = self.tree.selectedItems()
        return items[0].data(0, Qt.ItemDataRole.UserRole) if items else None

    def _sel_changed(self) -> None:
        sel = self._selected()
        self.b_ver.setEnabled(bool(sel and sel[1]))
        self.b_plugin.setEnabled(bool(sel))

    def _unpublish_version(self) -> None:
        sel = self._selected()
        if not sel or not sel[1]:
            return
        pid, ver = sel
        if QMessageBox.question(self, "Unpublish version", f"Unpublish {pid} {ver}?") != QMessageBox.StandardButton.Yes:
            return
        api = self.ctx.api
        self.task(lambda: api.unpublish(pid, ver), lambda _r: (self.ok(f"{pid} {ver} unpublished."), self.refresh()))

    def _unpublish_plugin(self) -> None:
        sel = self._selected()
        if not sel:
            return
        pid = sel[0]
        if QMessageBox.warning(self, "Unpublish plugin", f"Unpublish ALL versions of {pid}?",
                               QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Yes,
                               QMessageBox.StandardButton.Cancel) != QMessageBox.StandardButton.Yes:
            return
        api = self.ctx.api
        self.task(lambda: api.unpublish(pid), lambda _r: (self.ok(f"{pid} unpublished."), self.refresh()))
