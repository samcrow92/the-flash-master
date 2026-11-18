"""End-to-end tests over HTTP: accounts, submissions + review, marketplace files, admin routes, security."""
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

AGENT = "---\nname: hil-tester\ntitle: HIL tester\n---\nYou plan and analyse HIL test campaigns for body ECUs.\n"
WORKFLOW = "---\ncommand: hil-campaign\n---\n1. Do the campaign.\n"


def pkg(version="1.0.0", pid="body-pack", **extra):
    p = {"id": pid, "name": "Body pack", "version": version, "description": "d", "team": "Body", "tags": ["hil"],
         "agents": [{"file": "hil-tester.md", "content": AGENT}], "workflows": [{"file": "hil-campaign.md", "content": WORKFLOW}],
         "kinds": ["exam"]}  # client-sent kinds are ignored
    p.update(extra)
    return p


def make_user(c, name, role="user"):
    st, out = c.req("POST", "/api/v1/admin/users", c.admin, {"name": name, "role": role})
    assert st == 201, out
    assert out["token"].startswith("fs_") and len(out["token"]) == 43
    return out["user"], out["token"]


def test_health_and_auth(server):
    st, out = server.req("GET", "/api/v1/health")
    assert st == 200 and out["ok"] is True and out["name"] == "Test server" and out["publicRead"] is False
    for path in ("/api/v1/me", "/marketplace/index.json", "/updates/stable/latest.json", "/api/v1/submissions"):
        st, out = server.req("GET", path)
        assert st == 401 and out["code"] == "unauthorized", path
    st, _ = server.req("GET", "/api/v1/me", "fs_" + "x" * 40)
    assert st == 401
    st, out = server.req("GET", "/api/v1/me", server.admin)
    assert st == 200 and out["name"] == "mari" and out["role"] == "admin"
    st, out = server.req("GET", "/api/v1/me", server.admin, scheme="token")  # the updater's header form
    assert st == 200
    _, ana = make_user(server, "ana")
    st, out = server.req("GET", "/api/v1/admin/stats", ana)
    assert st == 403 and out["code"] == "forbidden"
    st, out = server.req("GET", "/no/such/route", server.admin)
    assert st == 404 and out["code"] == "not_found"


def test_submission_review_flow(server):
    c = server
    _, ana = make_user(c, "ana")
    _, bob = make_user(c, "bob")
    st, sub = c.req("POST", "/api/v1/submissions", ana, {"package": pkg(), "notes": "first"})
    assert st == 201, sub
    assert sub["status"] == "pending" and sub["kinds"] == ["agent", "workflow"] and sub["author"] == "ana" and sub["feedback"] is None
    # resubmitting the same pending id+version replaces it
    st, again = c.req("POST", "/api/v1/submissions", ana, {"package": pkg(description="better"), "notes": "second"})
    assert st == 200 and again["id"] == sub["id"] and again["notes"] == "second"
    # others cannot see it
    st, _ = c.req("GET", f"/api/v1/submissions/{sub['id']}", bob)
    assert st == 404
    st, mine = c.req("GET", f"/api/v1/submissions/{sub['id']}", ana)
    assert st == 200 and mine["package"]["description"] == "better" and "kinds" not in mine["package"]

    st, lst = c.req("GET", "/api/v1/admin/submissions?status=pending", c.admin)
    assert st == 200 and [s["id"] for s in lst["submissions"]] == [sub["id"]]
    st, detail = c.req("GET", f"/api/v1/admin/submissions/{sub['id']}", c.admin)
    assert detail["diff"]["previousVersion"] is None
    assert {f["path"]: f["change"] for f in detail["diff"]["files"]} == {
        "plugin.json": "added", "agents/hil-tester.md": "added", "workflows/hil-campaign.md": "added"}

    st, out = c.req("POST", f"/api/v1/admin/submissions/{sub['id']}/review", c.admin, {"decision": "reject", "feedback": "  "})
    assert st == 422 and out["code"] == "invalid"
    st, out = c.req("POST", f"/api/v1/admin/submissions/{sub['id']}/review", c.admin, {"decision": "approve", "feedback": "Looks good"})
    assert st == 200 and out["status"] == "approved" and out["reviewer"] == "mari" and out["reviewedAt"]

    st, idx = c.req("GET", "/marketplace/index.json", ana)
    assert st == 200 and idx["name"] == "Test server"
    [entry] = idx["plugins"]
    assert entry["id"] == "body-pack" and entry["version"] == "1.0.0" and entry["kinds"] == ["agent", "workflow"]
    assert entry["package"] == "plugins/body-pack-1.0.0.json" and entry["author"] == "ana" and len(entry["updated"]) == 10
    st, raw = c.req("GET", "/marketplace/" + entry["package"], ana)
    assert st == 200 and hashlib.sha256(raw if isinstance(raw, bytes) else json.dumps(raw).encode()).hexdigest()
    # sha256 must be over the exact served bytes: fetch raw
    body = c.svc.data.joinpath("marketplace", "plugins", "body-pack-1.0.0.json").read_bytes()
    assert hashlib.sha256(body).hexdigest() == entry["sha256"]
    assert raw == json.loads(body)

    st, mine = c.req("GET", "/api/v1/submissions", ana)
    assert mine["submissions"][0]["status"] == "approved" and mine["submissions"][0]["feedback"] == "Looks good"

    # ownership: bob may not publish ana's id; same version again is a conflict; admins may submit any id
    st, out = c.req("POST", "/api/v1/submissions", bob, {"package": pkg("1.1.0")})
    assert st == 403 and out["code"] == "forbidden"
    st, out = c.req("POST", "/api/v1/submissions", ana, {"package": pkg("1.0.0")})
    assert st == 409 and out["code"] == "conflict"
    st, _ = c.req("POST", "/api/v1/submissions", c.admin, {"package": pkg("1.0.1")})
    assert st == 201

    # second version: diff against 1.0.0, changes requested then approved
    v2 = pkg("1.1.0", agents=[{"file": "hil-tester.md", "content": AGENT + "More.\n"}], instructions="Rules")
    st, sub2 = c.req("POST", "/api/v1/submissions", ana, {"package": v2})
    st, detail = c.req("GET", f"/api/v1/admin/submissions/{sub2['id']}", c.admin)
    assert detail["diff"]["previousVersion"] == "1.0.0"
    changes = {f["path"]: f for f in detail["diff"]["files"]}
    assert changes["agents/hil-tester.md"]["change"] == "modified" and changes["agents/hil-tester.md"]["after"].endswith("More.\n")
    assert changes["instructions.md"]["change"] == "added" and "workflows/hil-campaign.md" not in changes
    st, out = c.req("POST", f"/api/v1/admin/submissions/{sub2['id']}/review", c.admin, {"decision": "changes_requested"})
    assert st == 422
    st, out = c.req("POST", f"/api/v1/admin/submissions/{sub2['id']}/review", c.admin, {"decision": "changes_requested", "feedback": "fix it"})
    assert out["status"] == "changes_requested" and out["feedback"] == "fix it"
    st, out = c.req("POST", f"/api/v1/admin/submissions/{sub2['id']}/review", c.admin, {"decision": "approve"})
    assert st == 200 and out["status"] == "approved" and out["feedback"] is None
    st, idx = c.req("GET", "/marketplace/index.json", ana)
    assert idx["plugins"][0]["version"] == "1.1.0" and "instructions" in idx["plugins"][0]["kinds"]
    st, out = c.req("POST", f"/api/v1/admin/submissions/{sub2['id']}/review", c.admin, {"decision": "reject", "feedback": "x"})
    assert st == 409

    # withdraw
    st, sub3 = c.req("POST", "/api/v1/submissions", ana, {"package": pkg("2.0.0")})
    st, _ = c.req("DELETE", f"/api/v1/submissions/{sub3['id']}", bob)
    assert st == 404
    st, out = c.req("DELETE", f"/api/v1/submissions/{sub3['id']}", ana)
    assert st == 200 and out["status"] == "withdrawn"
    st, _ = c.req("DELETE", f"/api/v1/submissions/{sub3['id']}", ana)
    assert st == 409

    # admin plugin list + unpublish
    st, pl = c.req("GET", "/api/v1/admin/plugins", c.admin)
    [p] = pl["plugins"]
    assert p["owner"] == "ana" and p["latest"] == "1.1.0" and [v["version"] for v in p["versions"]] == ["1.1.0", "1.0.0"]
    st, out = c.req("DELETE", "/api/v1/admin/plugins/body-pack/1.1.0", c.admin)
    assert st == 200 and out == {"ok": True}
    st, idx = c.req("GET", "/marketplace/index.json", ana)
    assert idx["plugins"][0]["version"] == "1.0.0"
    st, _ = c.req("GET", "/marketplace/plugins/body-pack-1.1.0.json", ana)
    assert st == 404
    st, _ = c.req("DELETE", "/api/v1/admin/plugins/body-pack", c.admin)
    st, idx = c.req("GET", "/marketplace/index.json", ana)
    assert idx["plugins"] == []
    st, _ = c.req("POST", "/api/v1/submissions", bob, {"package": pkg("3.0.0")})  # id is free again
    assert st == 201

    st, stats = c.req("GET", "/api/v1/admin/stats", c.admin)
    assert stats["users"] == 3 and stats["pendingSubmissions"] == 2 and stats["releases"] == {"stable": None, "beta": None}
    assert stats["diskFreeBytes"] > 0 and stats["uptimeSeconds"] >= 0


def test_package_validation(server):
    c = server
    _, ana = make_user(c, "ana")
    bad = [
        pkg(pid="Bad_ID"), pkg(pid="a"), pkg(version="1.0"), pkg(version="../1.0.0"),
        pkg(agents=[{"file": "../x.md", "content": AGENT}]),
        pkg(agents=[{"file": "x.txt", "content": AGENT}]),
        pkg(agents=[{"file": "x.md", "content": "no header"}]),
        pkg(workflows=[{"file": "w.md", "content": "---\nname: x\n---\nbody"}]),
        {"id": "empty-pack", "version": "1.0.0", "name": "x"},
        pkg(scripts=[{"file": "evil.exe", "content": "x"}]),
        pkg(scripts=[{"file": "big.py", "content": "x" * 200_001}]),
        pkg(agents=[{"file": "a.md", "content": AGENT}, {"file": "A.md", "content": AGENT}]),
        pkg(skills=[{"file": "Bad_Name.md", "content": "body"}]),
        pkg(skills=[{"file": "ok.md", "content": "---\ncommand: ok-skill\n---\n"}]),
    ]
    for p in bad:
        st, out = c.req("POST", "/api/v1/submissions", ana, {"package": p})
        assert st == 422 and out["code"] == "invalid", (p, out)
    st, out = c.req("POST", "/api/v1/submissions", ana, raw=b"{not json", headers={"Content-Type": "application/json"})
    assert st == 400
    big = pkg(instructions="x" * (2 * 1024 * 1024 + 10))
    st, out = c.req("POST", "/api/v1/submissions", ana, {"package": big})
    assert st == 413 and out["code"] == "too_large"
    # single script / single skill packages are fine; kinds derived server-side
    st, out = c.req("POST", "/api/v1/submissions", ana, {"package": {"id": "flash-script", "version": "0.1.0", "name": "s",
                                                                      "scripts": [{"file": "flash.ps1", "content": "Write-Host hi"}]}})
    assert st == 201 and out["kinds"] == ["script"]
    st, out = c.req("POST", "/api/v1/submissions", ana, {"package": {"id": "unslop", "version": "0.1.0",
                                                                      "skills": [{"file": "unslop.md", "content": "Do it"}], "kinds": ["agent"]}})
    assert st == 201 and out["kinds"] == ["skill"]


def test_users_admin(server):
    c = server
    user, tok = make_user(c, "ana")
    st, out = c.req("POST", "/api/v1/admin/users", c.admin, {"name": "ana"})
    assert st == 409
    st, out = c.req("POST", "/api/v1/admin/users", c.admin, {"name": "../x"})
    assert st == 422
    st, out = c.req("POST", f"/api/v1/admin/users/{user['id']}/token", c.admin)
    new = out["token"]
    assert c.req("GET", "/api/v1/me", tok)[0] == 401 and c.req("GET", "/api/v1/me", new)[0] == 200
    st, out = c.req("PATCH", f"/api/v1/admin/users/{user['id']}", c.admin, {"disabled": True})
    assert out["disabled"] is True and c.req("GET", "/api/v1/me", new)[0] == 401
    st, out = c.req("PATCH", f"/api/v1/admin/users/{user['id']}", c.admin, {"disabled": False, "role": "admin"})
    assert out["role"] == "admin" and c.req("GET", "/api/v1/admin/stats", new)[0] == 200
    st, users = c.req("GET", "/api/v1/admin/users", c.admin)
    assert {u["name"] for u in users["users"]} == {"mari", "ana"} and users["users"][0]["lastSeenAt"]
    st, out = c.req("DELETE", f"/api/v1/admin/users/{user['id']}", c.admin)
    assert out == {"ok": True}
    st, out = c.req("DELETE", "/api/v1/admin/users/1", c.admin)
    assert st == 409  # last admin
    st, out = c.req("DELETE", "/api/v1/admin/users/999", c.admin)
    assert st == 404
    st, out = c.req("GET", "/api/v1/admin/users/1", c.admin)
    assert st == 405


def test_public_read(public_server):
    c = public_server
    st, out = c.req("GET", "/api/v1/health")
    assert out["publicRead"] is True
    st, idx = c.req("GET", "/marketplace/index.json")
    assert st == 200 and idx["plugins"] == []
    assert c.req("GET", "/updates/stable/latest.json")[0] == 404  # readable, but nothing published
    assert c.req("POST", "/api/v1/submissions", body={"package": pkg()})[0] == 401
    assert c.req("GET", "/api/v1/me")[0] == 401
    assert c.req("GET", "/api/v1/admin/stats")[0] == 401


def test_path_traversal(server):
    c, t = server, server.admin
    c.svc.data.joinpath("secret.txt").write_text("x")
    paths = [
        "/marketplace/plugins/..%2F..%2Fflash.db", "/marketplace/plugins/../../flash.db", "/marketplace/files/..%2Fsecret.txt",
        "/marketplace/files/%2e%2e/secret.txt", "/updates/stable/..%2F..%2Fsecret.txt", "/updates/..%2F/latest.json",
        "/marketplace/files/.%5C..%5Csecret.txt", "/marketplace/files/", "/marketplace/plugins", "/marketplace/",
        "/updates/stable/", "/marketplace/files/x%00.txt", "/api/v1/submissions/..%2F1", "/marketplace/index.json/..",
    ]
    for p in paths:
        st, out = c.req("GET", p, t)
        assert st in (400, 404), (p, st)
    st, _ = c.req("PUT", "/api/v1/admin/releases/1.0.0/files/..%2Fx.exe", t, raw=b"x")
    assert st in (400, 404)
    st, _ = c.req("PUT", "/api/v1/admin/releases/..%2F..%2Fx/files/a.exe", t, raw=b"x")
    assert st in (400, 404)
    st, _ = c.req("PUT", "/api/v1/admin/releases/1.0.0/files/.hidden", t, raw=b"x")
    assert st == 400
    assert not any(c.svc.data.parent.glob("x*"))


def test_import_marketplace_example(server):
    c = server
    out = c.svc.import_marketplace(REPO / "marketplace-example")
    assert out["errors"] == [] and sorted(out["imported"]) == ["body-sw-test-pack@1.0.0", "diag-team-rules@2.1.0", "exam-team-setup@1.0.0"]
    assert c.svc.import_marketplace(REPO / "marketplace-example" / "plugins-src")["skipped"] == out["imported"]
    st, idx = c.req("GET", "/marketplace/index.json", c.admin)
    kinds = {p["id"]: p["kinds"] for p in idx["plugins"]}
    assert kinds == {"body-sw-test-pack": ["agent", "workflow", "skill", "script"], "diag-team-rules": ["instructions"], "exam-team-setup": ["exam"]}
    for e in idx["plugins"]:
        st, body = c.req("GET", "/marketplace/" + e["package"], c.admin)
        assert st == 200 and body["id"] == e["id"]
    st, exam = c.req("GET", "/marketplace/plugins/exam-team-setup-1.0.0.json", c.admin)
    assert exam["exam"]["pluginPackage"] == "files/README-exam-restapi.txt" and exam["exam"]["licensePort"] == 5053
    st, raw = c.req("GET", "/marketplace/" + exam["exam"]["pluginPackage"], c.admin)
    assert st == 200 and raw == (REPO / "marketplace-example" / "files" / "README-exam-restapi.txt").read_bytes()
    st, subs = c.req("GET", "/api/v1/admin/submissions?status=approved", c.admin)
    assert len(subs["submissions"]) == 3


def test_keep_alive_connection_reuse(server):
    import http.client
    c = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    h = {"Authorization": f"Bearer {server.admin}", "Content-Type": "application/json"}
    try:
        for _ in range(3):
            c.request("GET", "/api/v1/me", headers=h)
            r = c.getresponse()
            assert r.status == 200 and json.loads(r.read())["name"] == "mari"
        c.request("POST", "/api/v1/admin/users", body=b'{"name": "kim"}', headers=h)
        r = c.getresponse()
        assert r.status == 201
        r.read()
        c.request("GET", "/api/v1/admin/users", headers=h)
        r = c.getresponse()
        assert r.status == 200 and len(json.loads(r.read())["users"]) == 2
        # a body the route ignores must not leak into the next request
        c.request("POST", "/api/v1/admin/users/2/token", body=b'{"ignored": true}', headers=h)
        r = c.getresponse()
        assert r.status == 200
        r.read()
        c.request("GET", "/api/v1/me", headers=h)  # http.client reconnects if the server closed
        assert c.getresponse().status == 200
    finally:
        c.close()
