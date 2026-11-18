from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QGridLayout, QHBoxLayout, QVBoxLayout, QWidget

from ... import ops
from ...model import STATUS_LABELS, sort_submissions
from ...packaging import human_duration, human_size
from ..page import Page
from ..widgets import Card, Pill, StatCard, ago, button, hbox, label, section, separator, vbox


class DashboardPage(Page):
    title = "Dashboard"
    nav_label = "Dashboard"
    subtitle = "Health of your flash server at a glance"
    icon = "home"
    needs = "ssh"

    def build(self) -> None:
        self.actions.addWidget(button("Refresh", "", self.refresh))
        grid = QGridLayout()
        grid.setSpacing(16)
        self.s_users = StatCard("Users")
        self.s_plugins = StatCard("Published plugins")
        self.s_pending = StatCard("Pending reviews")
        self.s_disk = StatCard("Disk free")
        for i, c in enumerate((self.s_users, self.s_plugins, self.s_pending, self.s_disk)):
            grid.addWidget(c, 0, i)
        self.body.addLayout(grid)

        row = QHBoxLayout()
        row.setSpacing(16)
        # service
        svc = Card()
        svc.add(hbox(section("Service"), None))
        self.svc_pill = Pill("unknown")
        svc.add(hbox(label("flash-server.service", "h2"), None, self.svc_pill))
        self.svc_detail = label("–", "muted", wrap=True)
        svc.add(self.svc_detail)
        svc.lay.addStretch(1)
        self.restart_btn = button("Restart", "", self._restart)
        svc.add(hbox(self.restart_btn, button("View logs", "ghost", lambda: self.go_to.emit("deploy")), None))
        row.addWidget(svc, 1)
        # releases
        rel = Card()
        rel.add(section("Releases"))
        self.rel_stable = label("–", "stat")
        self.rel_beta = label("–", "stat")
        rel.add(hbox(vbox(label("stable", "statLabel"), self.rel_stable, spacing=2), 24,
                     vbox(label("beta", "statLabel"), self.rel_beta, spacing=2), None))
        rel.lay.addStretch(1)
        rel.add(hbox(button("Manage releases", "ghost", lambda: self.go_to.emit("releases")), None))
        row.addWidget(rel, 1)
        # server
        srv = Card()
        srv.add(section("Server"))
        self.srv_rows = {}
        for key in ("Name", "Version", "Data", "Uptime", "API via"):
            v = label("–", selectable=True)
            v.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.srv_rows[key] = v
            srv.add(hbox(label(key, "muted"), None, v))
        row.addWidget(srv, 1)
        self.body.addLayout(row)

        # pending list
        pend = Card()
        pend.add(hbox(section("Waiting for review"), None,
                      button("Open review queue", "ghost", lambda: self.go_to.emit("review"))))
        self.pending_box = QVBoxLayout()
        self.pending_box.setSpacing(0)
        pend.add(self.pending_box)
        pend.lay.addStretch(1)
        self.body.addWidget(pend, 1)

    def refresh(self) -> None:
        ctx = self.ctx
        session = ctx.session
        self.task(lambda: ops.service_status(session), self._show_service)
        p = ctx.profile
        self.srv_rows["API via"].setText("SSH tunnel" if (p and (p.use_tunnel or not p.public_url)) else (p.public_url if p else "–"))
        info = ctx.server_info or {}
        self.srv_rows["Name"].setText(info.get("name", "–"))
        self.srv_rows["Version"].setText(info.get("version", "–"))
        if not ctx.api_ready:
            self.s_users.set("–", "admin token needed")
            return
        api = ctx.api
        self.task(lambda: (api.stats(), sort_submissions(api.submissions("pending"))), self._show_stats)

    def _show_service(self, st: dict) -> None:
        active = st.get("active", "unknown")
        self.svc_pill.set(active if active != "active" else "running", {"active": "green", "failed": "red",
                                                                       "activating": "amber"}.get(active, "muted"))
        bits = []
        if st.get("sub"):
            bits.append(st["sub"])
        if st.get("pid") and st["pid"] != "0":
            bits.append(f"PID {st['pid']}")
        if st.get("since"):
            bits.append(f"since {st['since']}")
        if st.get("loaded") == "not-found":
            bits = ["not installed yet — use Setup & deploy"]
        self.svc_detail.setText(" · ".join(bits) or "–")

    def _show_stats(self, res) -> None:
        stats, pending = res
        self.s_users.set(str(stats.get("users", "–")), "accounts with a token")
        self.s_plugins.set(str(stats.get("plugins", "–")), "in the marketplace")
        n = stats.get("pendingSubmissions", len(pending))
        self.s_pending.set(str(n), "submissions waiting" if n else "all caught up")
        self.s_disk.set(human_size(stats.get("diskFreeBytes")), stats.get("dataDir", ""))
        rel = stats.get("releases") or {}
        self.rel_stable.setText(rel.get("stable") or "–")
        self.rel_beta.setText(rel.get("beta") or "–")
        self.srv_rows["Data"].setText(stats.get("dataDir", "–"))
        self.srv_rows["Uptime"].setText(human_duration(stats.get("uptimeSeconds")))
        self.ctx.pending_count.emit(n)
        while self.pending_box.count():
            it = self.pending_box.takeAt(0)
            if it.widget():
                it.widget().deleteLater()
        if not pending:
            self.pending_box.addWidget(label("Nothing to review.", "muted"))
        for s in pending[:5]:
            w = QWidget()
            lay = hbox(vbox(label(f"{s['name']}  ·  {s['version']}", "h2"),
                            label(f"{s['pluginId']} · by {s['author']} · {ago(s.get('createdAt'))}", "small"), spacing=2),
                       None, label("  ".join(s.get("kinds") or []), "small"), 12, Pill(STATUS_LABELS.get(s["status"], s["status"]), "amber"),
                       margins=(0, 10, 0, 10))
            w.setLayout(lay)
            self.pending_box.addWidget(w)
            self.pending_box.addWidget(separator())

    def _restart(self) -> None:
        session = self.ctx.session
        self.task(lambda: ops.service_action(session, "restart"), lambda st: (self._show_service(st), self.ok("Service restarted.")),
                  busy=self.restart_btn)
