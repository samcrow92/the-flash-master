from __future__ import annotations

import os
import posixpath
import time

from PySide6.QtCore import QDir, Qt
from PySide6.QtWidgets import (QAbstractItemView, QComboBox, QDialog, QDialogButtonBox, QFileDialog,
                               QFileSystemModel, QGridLayout, QHBoxLayout, QHeaderView, QLineEdit, QListWidget,
                               QMessageBox, QPlainTextEdit, QProgressBar, QToolButton, QTreeView, QTreeWidget,
                               QTreeWidgetItem, QVBoxLayout, QWidget)

from ... import ops, packaging
from .. import icons
from ..page import Page
from ..widgets import Card, LogView, button, hbox, label, section, vbox


class ReleaseDialog(QDialog):
    def __init__(self, parent, folder: str):
        super().__init__(parent)
        self.setWindowTitle("Upload release folder")
        self.setMinimumWidth(560)
        scan = packaging.scan_release_folder(folder)
        self.folder = folder
        lay = QVBoxLayout(self)
        lay.setContentsMargins(22, 20, 22, 18)
        lay.setSpacing(12)
        lay.addWidget(label(folder, "small", wrap=True))
        files = QListWidget()
        for f in scan["files"]:
            files.addItem(f"{f}    {packaging.human_size(scan['sizes'][f])}")
        files.setMaximumHeight(140)
        lay.addWidget(files)
        g = QGridLayout()
        g.setHorizontalSpacing(12)
        g.setVerticalSpacing(10)
        self.version = QLineEdit(scan["version"])
        self.channel = QComboBox()
        self.channel.addItems(["beta", "stable"])
        self.notes = QPlainTextEdit(scan["notes"])
        self.notes.setPlaceholderText("Release notes shown in the app's update banner")
        self.notes.setMaximumHeight(110)
        g.addWidget(label("Version", "muted"), 0, 0)
        g.addWidget(self.version, 0, 1)
        g.addWidget(label("Channel", "muted"), 0, 2)
        g.addWidget(self.channel, 0, 3)
        g.addWidget(label("Notes", "muted"), 1, 0, Qt.AlignmentFlag.AlignTop)
        g.addWidget(self.notes, 1, 1, 1, 3)
        lay.addLayout(g)
        bb = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel)
        up = button("Upload && publish", "primary")
        bb.addButton(up, QDialogButtonBox.ButtonRole.AcceptRole)
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        lay.addWidget(bb)
        self.has_files = bool(scan["files"])


class TransferPage(Page):
    title = "Transfer"
    nav_label = "Transfer"
    subtitle = "Move files over SFTP, ship releases and plugins, back up the data"
    icon = "transfer"
    needs = "ssh"

    def build(self) -> None:
        self.remote_cwd = ""
        quick = QHBoxLayout()
        quick.setSpacing(14)
        self.quick_cards = []
        for ic, title, text, fn in (
                ("tag", "Upload release folder", "Upload each file via the release API, then publish.", self._release),
                ("store", "Import marketplace", "Upload a plugins-src tree and import it as approved.", self._import_market),
                ("database", "Backup", "Run flashserver backup and download the tar.gz.", self._backup),
                ("restore", "Restore", "Upload a backup and restore it (service restarts).", self._restore)):
            c = Card(margins=16, spacing=6, flat=True)
            icl = label()
            icl.setProperty("icon", ic)
            self.quick_cards.append(icl)
            c.add(hbox(icl, label(title, "h2"), None, spacing=10))
            c.add(label(text, "small", wrap=True))
            c.lay.addStretch(1)
            b = button("Run", "", fn)
            c.add(hbox(None, b))
            c.setMinimumHeight(132)
            quick.addWidget(c, 1)
        self.body.addLayout(quick)

        panes = QHBoxLayout()
        panes.setSpacing(12)
        # local
        lc = Card(margins=14, spacing=8)
        self.local_path = QLineEdit(os.path.expanduser("~"))
        self.local_path.returnPressed.connect(lambda: self._set_local(self.local_path.text()))
        lc.add(hbox(section("This computer"), None))
        lc.add(hbox(self._tool("up", "Up", lambda: self._set_local(os.path.dirname(self.local_path.text()))),
                    self.local_path, spacing=6))
        self.fs = QFileSystemModel()
        self.fs.setFilter(QDir.Filter.AllEntries | QDir.Filter.NoDotAndDotDot | QDir.Filter.Hidden)
        self.fs.setRootPath("")
        self.local = QTreeView()
        self.local.setModel(self.fs)
        self.local.setRootIsDecorated(False)
        self.local.setItemsExpandable(False)
        self.local.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.local.setColumnHidden(2, True)
        self.local.header().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.local.header().setStretchLastSection(False)
        self.local.header().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.local.header().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.local.doubleClicked.connect(self._local_open)
        lc.add(self.local, 1)
        panes.addWidget(lc, 1)

        mid = QVBoxLayout()
        mid.addStretch(1)
        self.up_btn = button("Upload  →", "primary", self._upload)
        self.down_btn = button("←  Download", "", self._download)
        mid.addWidget(self.up_btn)
        mid.addSpacing(6)
        mid.addWidget(self.down_btn)
        mid.addStretch(1)
        panes.addLayout(mid)

        rc = Card(margins=14, spacing=8)
        self.remote_path = QLineEdit()
        self.remote_path.returnPressed.connect(lambda: self._set_remote(self.remote_path.text()))
        rc.add(hbox(section("Server"), None))
        rc.add(hbox(self._tool("up", "Up", lambda: self._set_remote(posixpath.dirname(self.remote_cwd.rstrip("/")) or "/")),
                    self.remote_path, self._tool("refresh", "Refresh", lambda: self._set_remote(self.remote_cwd)), spacing=6))
        self.remote = QTreeWidget()
        self.remote.setHeaderLabels(["Name", "Size", "Modified"])
        self.remote.setRootIsDecorated(False)
        self.remote.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.remote.header().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.remote.header().setStretchLastSection(False)
        self.remote.header().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.remote.header().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.remote.itemDoubleClicked.connect(self._remote_open)
        rc.add(self.remote, 1)
        panes.addWidget(rc, 1)
        self.body.addLayout(panes, 1)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress_label = label("Idle", "small")
        self.body.addLayout(hbox(self.progress_label, self.progress, spacing=12))
        self.log = LogView(max_lines=500)
        self.log.setMaximumHeight(96)
        self.body.addWidget(self.log)
        self._set_local(os.path.expanduser("~"))

    def _tool(self, ic: str, tip: str, fn) -> QToolButton:
        b = QToolButton()
        b.setProperty("kind", "ghost")
        b.setProperty("icon_name", ic)
        b.setToolTip(tip)
        b.setCursor(Qt.CursorShape.PointingHandCursor)
        b.clicked.connect(lambda _=False: fn())
        return b

    def apply_theme(self, t) -> None:
        for icl in self.quick_cards:
            icl.setPixmap(icons.pixmap(icl.property("icon"), t.accent, 20))
        for b in self.findChildren(QToolButton):
            name = b.property("icon_name")
            if name:
                b.setIcon(icons.icon(name, t.muted, 16))

    def refresh(self) -> None:
        if not self.remote_cwd:
            session = self.ctx.session
            self.task(session.home, self._set_remote)
        else:
            self._set_remote(self.remote_cwd)

    def connection_changed(self) -> None:
        if not self.ctx.connected:
            self.remote_cwd = ""
            self.remote.clear()

    # ---------------------------------------------------------------- panes
    def _set_local(self, path: str) -> None:
        if not os.path.isdir(path):
            return
        self.local_path.setText(path)
        self.local.setRootIndex(self.fs.index(path))

    def _local_open(self, idx) -> None:
        path = self.fs.filePath(idx)
        if os.path.isdir(path):
            self._set_local(path)

    def _set_remote(self, path: str) -> None:
        session = self.ctx.session
        if session is None:
            return

        def done(entries):
            self.remote_cwd = path
            self.remote_path.setText(path)
            self.remote.clear()
            t = self.ctx.theme
            for e in entries:
                it = QTreeWidgetItem([e["name"] + ("/" if e["dir"] else ""), "" if e["dir"] else packaging.human_size(e["size"]),
                                      time.strftime("%Y-%m-%d %H:%M", time.localtime(e["mtime"])) if e["mtime"] else ""])
                it.setData(0, Qt.ItemDataRole.UserRole, e)
                if t:
                    it.setIcon(0, icons.icon("folder" if e["dir"] else "file", t.accent if e["dir"] else t.muted, 16))
                self.remote.addTopLevelItem(it)

        self.task(lambda: session.listdir(path), done)

    def _remote_open(self, it: QTreeWidgetItem) -> None:
        e = it.data(0, Qt.ItemDataRole.UserRole)
        if e and e["dir"]:
            self._set_remote(posixpath.join(self.remote_cwd, e["name"]))

    # ------------------------------------------------------------- transfers
    def _on_progress(self, ev) -> None:
        if ev[0] == "line":
            self.log.append_line(ev[1])
        else:
            _, a, b, name = ev
            self.progress.setValue(int(a * 100 / max(1, b)))
            self.progress_label.setText(f"{name}  {packaging.human_size(a)} / {packaging.human_size(b)}")

    def _run(self, label_text: str, work, done_msg: str, refresh_remote: bool = True, done=None):
        self.progress.setValue(0)
        self.progress_label.setText(label_text)

        def ok(res):
            self.progress.setValue(100)
            self.progress_label.setText("Done")
            self.ok(done_msg if isinstance(done_msg, str) else done_msg(res))
            if refresh_remote and self.remote_cwd:
                self._set_remote(self.remote_cwd)
            if done:
                done(res)

        self.task(work, ok, progress=self._on_progress)

    def _upload(self) -> None:
        paths = sorted({self.fs.filePath(i) for i in self.local.selectionModel().selectedRows()})
        files = [p for p in paths if os.path.isfile(p)]
        if not files:
            self.show_banner("info", "Select one or more local files to upload.")
            return
        session, target = self.ctx.session, self.remote_cwd

        def work(progress):
            for f in files:
                name = os.path.basename(f)
                session.put(f, posixpath.join(target, name), lambda a, b, n=name: progress(("bytes", a, b, n)))
            return len(files)

        self._run("Uploading…", work, lambda n: f"Uploaded {n} file(s) to {target}.")

    def _download(self) -> None:
        items = [it.data(0, Qt.ItemDataRole.UserRole) for it in self.remote.selectedItems()]
        files = [e for e in items if e and not e["dir"]]
        if not files:
            self.show_banner("info", "Select one or more server files to download.")
            return
        session, src, dest = self.ctx.session, self.remote_cwd, self.local_path.text()

        def work(progress):
            for e in files:
                session.get(posixpath.join(src, e["name"]), os.path.join(dest, e["name"]),
                            lambda a, b, n=e["name"]: progress(("bytes", a, b, n)))
            return len(files)

        self._run("Downloading…", work, lambda n: f"Downloaded {n} file(s) to {dest}.", refresh_remote=False)

    # ---------------------------------------------------------- quick actions
    def _release(self) -> None:
        if not self.ctx.api_ready:
            self.error("The release upload uses the admin API: an admin token is needed (Connections).")
            return
        folder = QFileDialog.getExistingDirectory(self, "Release folder (TheFlashMaster release/)", self.local_path.text())
        if not folder:
            return
        dlg = ReleaseDialog(self, folder)
        if not dlg.has_files:
            self.error("That folder has no files to upload.")
            return
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        version, channel, notes = dlg.version.text().strip(), dlg.channel.currentText(), dlg.notes.toPlainText()
        if not version:
            self.error("A version is required.")
            return
        api = self.ctx.api

        def work(progress):
            return ops.upload_release(api, folder, version, channel, notes, on_line=lambda l: progress(("line", l)),
                                      progress=lambda a, b: progress(("bytes", a, b, version)))

        self._run("Uploading release…", work, f"Release {version} published to {channel}.", refresh_remote=False)

    def _import_market(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "plugins-src folder", self.local_path.text())
        if not folder:
            return
        session = self.ctx.session

        def work(progress):
            return ops.import_marketplace(session, folder, on_line=lambda l: progress(("line", l)),
                                          progress=lambda a, b: progress(("bytes", a, b, "plugins-src")))

        self._run("Importing marketplace…", work,
                  lambda r: f"Marketplace imported{': ' + str(r.get('imported')) + ' plugin(s)' if r.get('imported') is not None else ''}.",
                  refresh_remote=False)

    def _backup(self) -> None:
        name = f"flash-backup-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz"
        path, _ = QFileDialog.getSaveFileName(self, "Save backup", os.path.join(self.local_path.text(), name),
                                              "Backups (*.tar.gz)")
        if not path:
            return
        session = self.ctx.session

        def work(progress):
            return ops.backup(session, path, on_line=lambda l: progress(("line", l)),
                              progress=lambda a, b: progress(("bytes", a, b, os.path.basename(path))))

        self._run("Backing up…", work, f"Backup saved to {path}.", refresh_remote=False)

    def _restore(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Backup to restore", self.local_path.text(), "Backups (*.tar.gz)")
        if not path:
            return
        if QMessageBox.warning(
                self, "Restore backup",
                f"Restore {os.path.basename(path)}?\n\nThe service is stopped, the database and data folder are replaced "
                "with the backup's content, then the service starts again. Changes since the backup are lost.",
                QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Yes,
                QMessageBox.StandardButton.Cancel) != QMessageBox.StandardButton.Yes:
            return
        session = self.ctx.session

        def work(progress):
            return ops.restore(session, path, on_line=lambda l: progress(("line", l)),
                               progress=lambda a, b: progress(("bytes", a, b, os.path.basename(path))))

        self._run("Restoring…", work, "Backup restored and service restarted.", refresh_remote=False)
