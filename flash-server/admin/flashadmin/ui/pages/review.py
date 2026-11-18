from __future__ import annotations

from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import (QButtonGroup, QHBoxLayout, QListWidget, QListWidgetItem, QPlainTextEdit, QSplitter,
                               QTabWidget, QWidget)

from ...model import STATUS_LABELS, diff_stats, package_files, sort_submissions, unified
from ..diff_view import DiffView
from ..page import Page
from ..widgets import Card, Pill, ago, button, hbox, label, section, short_time, vbox

CHANGE_MARK = {"added": "A", "removed": "D", "modified": "M"}
CHANGE_COLOR = {"added": "green", "removed": "red", "modified": "amber"}


class ReviewPage(Page):
    title = "Review queue"
    nav_label = "Review queue"
    subtitle = "Approve, reject or send back plugin submissions from the app"
    icon = "inbox"
    needs = "api"

    def build(self) -> None:
        self.current = None
        self.filter = "pending"
        self.actions.addWidget(button("Refresh", "", self.refresh))
        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        left = Card(margins=14, spacing=10)
        seg = QButtonGroup(self)
        segs = []
        for key, text in (("pending", "Pending"), ("changes_requested", "Changes"), ("all", "All")):
            b = button(text, "seg")
            b.setCheckable(True)
            b.setChecked(key == "pending")
            b.clicked.connect(lambda _=False, k=key: self._set_filter(k))
            seg.addButton(b)
            segs.append(b)
        left.add(hbox(*segs, None, spacing=4))
        self.list = QListWidget()
        self.list.setSpacing(1)
        self.list.currentRowChanged.connect(self._select)
        left.add(self.list, 1)
        left.setMinimumWidth(300)
        split.addWidget(left)

        self.detail = Card(margins=22, spacing=12)
        d = self.detail
        self.d_title = label("Select a submission", "h2")
        self.d_title.setStyleSheet("font-size: 18px;")
        self.d_status = Pill("")
        d.add(hbox(self.d_title, None, self.d_status))
        self.d_meta = label("", "muted", wrap=True, selectable=True)
        d.add(self.d_meta)
        self.d_kinds = QHBoxLayout()
        self.d_kinds.setSpacing(6)
        d.add(self.d_kinds)
        self.d_notes = label("", wrap=True, selectable=True)
        self.d_notes.setObjectName("notes")
        notes_box = Card(margins=14, spacing=4, flat=True)
        notes_box.add(section("Author notes"))
        notes_box.add(self.d_notes)
        self.notes_box = notes_box
        d.add(notes_box)

        self.d_tabs = QTabWidget()
        self.d_tabs.setDocumentMode(True)
        # changes
        ch = QWidget()
        self.ch_files = QListWidget()
        self.ch_files.setFixedWidth(250)
        self.ch_files.currentRowChanged.connect(self._show_change)
        self.ch_view = DiffView()
        ch.setLayout(hbox(self.ch_files, self.ch_view, spacing=10, margins=(0, 10, 0, 0)))
        self.d_tabs.addTab(ch, "Changes")
        # files
        fl = QWidget()
        self.pk_files = QListWidget()
        self.pk_files.setFixedWidth(250)
        self.pk_files.currentRowChanged.connect(self._show_file)
        self.pk_view = DiffView()
        fl.setLayout(hbox(self.pk_files, self.pk_view, spacing=10, margins=(0, 10, 0, 0)))
        self.d_tabs.addTab(fl, "Package files")
        d.add(self.d_tabs, 1)

        self.feedback = QPlainTextEdit()
        self.feedback.setPlaceholderText("Feedback for the author — required to reject or request changes. "
                                         "It shows up in their app under My submissions.")
        self.feedback.setFixedHeight(76)
        d.add(self.feedback)
        self.b_reject = button("Reject", "danger", lambda: self._decide("reject"))
        self.b_changes = button("Request changes", "", lambda: self._decide("changes_requested"))
        self.b_approve = button("Approve && publish", "primary", lambda: self._decide("approve"))
        d.add(hbox(self.b_reject, None, self.b_changes, self.b_approve))
        split.addWidget(self.detail)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setSizes([330, 900])
        self.body.addWidget(split, 1)
        self._set_actions_enabled(False)

    def apply_theme(self, t) -> None:
        self.ch_view.set_theme(t)
        self.pk_view.set_theme(t)

    def _set_filter(self, key: str) -> None:
        self.filter = key
        self.refresh()

    def refresh(self) -> None:
        api, status = self.ctx.api, self.filter
        self.task(lambda: sort_submissions(api.submissions(status)), self._show_list)
        self.ctx.refresh_pending()

    def _show_list(self, subs) -> None:
        keep = self.current["id"] if self.current else None
        self.subs = subs
        self.list.blockSignals(True)
        self.list.clear()
        sel = 0
        for i, s in enumerate(subs):
            it = QListWidgetItem()
            it.setSizeHint(QSize(0, 74))
            self.list.addItem(it)
            w = QWidget()
            w.setLayout(vbox(hbox(label(s.get("name") or s["pluginId"], "h2"), None,
                                  Pill(STATUS_LABELS.get(s["status"], s["status"]), Pill.COLORS.get(s["status"], "muted"), dot=False)),
                             label(f"{s['pluginId']} {s['version']} · {s['author']} · {ago(s.get('createdAt'))}", "small"),
                             spacing=4, margins=(10, 8, 10, 8)))
            w.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
            self.list.setItemWidget(it, w)
            if s["id"] == keep:
                sel = i
        self.list.blockSignals(False)
        if subs:
            self.list.setCurrentRow(sel)
            self._select(sel)
        else:
            self.current = None
            self.d_title.setText("Nothing here" if self.filter != "pending" else "All caught up")
            self.d_meta.setText("No submissions match this filter.")
            self.d_status.hide()
            self.notes_box.hide()
            self._clear_kinds()
            self.ch_files.clear()
            self.pk_files.clear()
            self.ch_view.show_text("")
            self.pk_view.show_text("")
            self._set_actions_enabled(False)

    def _select(self, row: int) -> None:
        if row < 0 or row >= len(getattr(self, "subs", [])):
            return
        api, sid = self.ctx.api, self.subs[row]["id"]
        self.task(lambda: api.submission(sid), self._show_detail)

    def _clear_kinds(self) -> None:
        while self.d_kinds.count():
            it = self.d_kinds.takeAt(0)
            if it.widget():
                it.widget().deleteLater()

    def _show_detail(self, s: dict) -> None:
        self.current = s
        pkg = s.get("package") or {}
        diff = s.get("diff") or {"files": []}
        self.d_title.setText(f"{s.get('name') or s['pluginId']}  ·  {s['version']}")
        self.d_status.show()
        self.d_status.set(STATUS_LABELS.get(s["status"], s["status"]), Pill.COLORS.get(s["status"], "muted"))
        prev = diff.get("previousVersion")
        meta = [f"<b>{s['pluginId']}</b>", f"by {s['author']}", f"submitted {short_time(s.get('createdAt'))} UTC",
                f"previous version {prev}" if prev else "new plugin"]
        if pkg.get("team"):
            meta.append(f"team {pkg['team']}")
        if s.get("reviewer"):
            meta.append(f"reviewed by {s['reviewer']}")
        self.d_meta.setText("  ·  ".join(meta) + (f"<br>{pkg['description']}" if pkg.get("description") else ""))
        self._clear_kinds()
        for k in s.get("kinds") or []:
            self.d_kinds.addWidget(Pill(k, "blue"))
        self.d_kinds.addStretch(1)
        self.notes_box.setVisible(bool(s.get("notes") or s.get("feedback")))
        notes = s.get("notes") or "—"
        if s.get("feedback"):
            notes += f"\n\nReviewer feedback: {s['feedback']}"
        self.d_notes.setText(notes)
        # changes
        files = diff.get("files") or []
        add, rem = diff_stats(files)
        self.d_tabs.setTabText(0, f"Changes  {len(files)} files  +{add} −{rem}" if files else "Changes")
        self.ch_files.blockSignals(True)
        self.ch_files.clear()
        for f in files:
            it = QListWidgetItem(f"{CHANGE_MARK.get(f['change'], '?')}   {f['path']}")
            t = self.ctx.theme
            if t is not None:
                from PySide6.QtGui import QColor

                it.setForeground(QColor(getattr(t, CHANGE_COLOR.get(f["change"], "muted"), t.fg)))
            self.ch_files.addItem(it)
        self.ch_files.blockSignals(False)
        self._files_diff = files
        if files:
            self.ch_files.setCurrentRow(0)
            self._show_change(0)
        else:
            self.ch_view.show_text("First version of this plugin — see Package files." if not prev else "No file changes.")
        # package files
        self._pkg_files = package_files(pkg)
        self.pk_files.blockSignals(True)
        self.pk_files.clear()
        for path, content in self._pkg_files:
            self.pk_files.addItem(f"{path}    {len(content.encode('utf-8')):,} B")
        self.pk_files.blockSignals(False)
        if self._pkg_files:
            self.pk_files.setCurrentRow(0)
            self._show_file(0)
        self.feedback.setPlainText("")
        self._set_actions_enabled(s["status"] in ("pending", "changes_requested"))

    def _show_change(self, row: int) -> None:
        if 0 <= row < len(self._files_diff):
            f = self._files_diff[row]
            self.ch_view.show_diff(unified(f.get("before") or "", f.get("after") or "", f["path"]))

    def _show_file(self, row: int) -> None:
        if 0 <= row < len(self._pkg_files):
            self.pk_view.show_text(self._pkg_files[row][1])

    def _set_actions_enabled(self, on: bool) -> None:
        for b in (self.b_reject, self.b_changes, self.b_approve):
            b.setEnabled(on)
        self.feedback.setEnabled(on)

    def _decide(self, decision: str) -> None:
        if not self.current:
            return
        fb = self.feedback.toPlainText().strip()
        if decision != "approve" and not fb:
            self.error("Write feedback for the author first: it is required to reject or request changes.")
            self.feedback.setFocus()
            return
        api, sid = self.ctx.api, self.current["id"]
        label_ = {"approve": "approved and published", "reject": "rejected",
                  "changes_requested": "sent back for changes"}[decision]
        name = f"{self.current['pluginId']} {self.current['version']}"
        self.task(lambda: api.review(sid, decision, fb),
                  lambda _s: (self.ok(f"{name} {label_}. The author sees it in their app."), self.refresh()),
                  busy={"approve": self.b_approve, "reject": self.b_reject, "changes_requested": self.b_changes}[decision])
