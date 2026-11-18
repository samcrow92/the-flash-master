"""Release upload/publish/promote/delete and the updater-compatible feed; CLI commands."""
import hashlib
import io
import json
from contextlib import redirect_stdout
from pathlib import Path

from flashserver.cli import main

REPO = Path(__file__).resolve().parents[2]


def upload(c, version, name, data, sha=None, token=None):
    q = f"?sha256={sha}" if sha else ""
    return c.req("PUT", f"/api/v1/admin/releases/{version}/files/{name}{q}", token or c.admin, raw=data,
                 headers={"Content-Type": "application/octet-stream"})


def test_release_flow(server):
    c = server
    setup, portable = b"MZ setup " * 1000, b"MZ portable " * 500
    st, out = upload(c, "0.5.0", "TheFlashMaster-0.5.0-x64-setup.exe", setup, sha="0" * 64)
    assert st == 422 and out["code"] == "invalid"
    st, out = upload(c, "0.5.0", "TheFlashMaster-0.5.0-x64-setup.exe", setup, sha=hashlib.sha256(setup).hexdigest())
    assert st == 200 and out == {"name": "TheFlashMaster-0.5.0-x64-setup.exe", "size": len(setup), "sha256": hashlib.sha256(setup).hexdigest()}
    st, out = upload(c, "0.5.0", "TheFlashMaster-0.5.0-portable.exe", portable)
    assert st == 200
    st, out = upload(c, "0.5.0", "SHA256SUMS.txt", b"sums")
    assert st == 200
    st, out = c.req("POST", "/api/v1/admin/releases/0.5.0/publish", c.admin, {"channel": "stable", "notes": "First"})
    assert st == 200 and out["published"] and out["channel"] == "stable"

    st, m = c.req("GET", "/updates/stable/latest.json", c.admin, scheme="token")
    assert st == 200 and m["version"] == "0.5.0" and m["notes"] == "First" and m["date"].endswith("Z")
    files = {f["name"]: f for f in m["files"]}
    assert set(files) == {"TheFlashMaster-0.5.0-x64-setup.exe", "TheFlashMaster-0.5.0-portable.exe"}
    assert files["TheFlashMaster-0.5.0-x64-setup.exe"]["kind"] == "setup" and files["TheFlashMaster-0.5.0-portable.exe"]["kind"] == "portable"
    for f in m["files"]:  # updater: new URL(name, `${base}/`) relative to /updates/<channel>/
        st, body = c.req("GET", f"/updates/stable/{f['name']}", c.admin)
        assert st == 200 and len(body) == f["size"] and hashlib.sha256(body).hexdigest() == f["sha256"]
    assert c.req("GET", "/updates/latest.json", c.admin)[1] == m
    assert c.req("GET", "/updates/beta/latest.json", c.admin)[1]["version"] == "0.5.0"  # beta = newest of stable and beta
    assert c.req("GET", "/updates/nightly/latest.json", c.admin)[0] == 404

    # publish needs an .exe with the version in its name
    upload(c, "0.6.0-beta.1", "notes.txt", b"n")
    st, out = c.req("POST", "/api/v1/admin/releases/0.6.0-beta.1/publish", c.admin, {"channel": "beta"})
    assert st == 422
    upload(c, "0.6.0-beta.1", "TheFlashMaster-0.6.0-beta.1-x64-setup.exe", b"beta")
    st, out = c.req("POST", "/api/v1/admin/releases/0.6.0-beta.1/publish", c.admin, {"channel": "beta", "notes": "b"})
    assert st == 200
    assert c.req("GET", "/updates/beta/latest.json", c.admin)[1]["version"] == "0.6.0-beta.1"
    assert c.req("GET", "/updates/stable/latest.json", c.admin)[1]["version"] == "0.5.0"
    st, body = c.req("GET", "/updates/beta/TheFlashMaster-0.6.0-beta.1-x64-setup.exe", c.admin)
    assert body == b"beta"

    st, rel = c.req("GET", "/api/v1/admin/releases", c.admin)
    assert rel["current"] == {"stable": "0.5.0", "beta": "0.6.0-beta.1"}
    assert [r["version"] for r in rel["releases"]] == ["0.6.0-beta.1", "0.5.0"]

    # delete guard, promote, rollback
    st, out = c.req("DELETE", "/api/v1/admin/releases/0.5.0", c.admin)
    assert st == 409 and out["code"] == "conflict"
    st, out = c.req("POST", "/api/v1/admin/releases/0.6.0-beta.1/promote", c.admin, {"channel": "stable"})
    assert st == 200 and out["channel"] == "stable"
    assert c.req("GET", "/updates/stable/latest.json", c.admin)[1]["version"] == "0.6.0-beta.1"
    st, out = c.req("POST", "/api/v1/admin/releases/0.5.0/promote", c.admin, {"channel": "stable"})  # roll back
    assert c.req("GET", "/updates/stable/latest.json", c.admin)[1]["version"] == "0.5.0"
    st, out = c.req("POST", "/api/v1/admin/releases/0.6.0-beta.1/promote", c.admin, {"channel": "stable"})
    st, out = c.req("DELETE", "/api/v1/admin/releases/0.5.0", c.admin)
    assert st == 200 and out == {"ok": True}
    assert c.req("GET", "/updates/stable/TheFlashMaster-0.5.0-portable.exe", c.admin)[0] == 404
    upload(c, "0.7.0", "x.txt", b"draft")
    st, out = c.req("POST", "/api/v1/admin/releases/0.7.0/promote", c.admin, {"channel": "stable"})
    assert st == 409
    assert c.req("DELETE", "/api/v1/admin/releases/9.9.9", c.admin)[0] == 404

    # users can download but not upload
    st, tok = c.req("POST", "/api/v1/admin/users", c.admin, {"name": "ana"})
    assert upload(c, "0.8.0", "a.exe", b"x", token=tok["token"])[0] == 403
    assert c.req("GET", "/updates/stable/latest.json", tok["token"])[0] == 200
    st, out = c.req("PUT", "/api/v1/admin/releases/0.8.0/files/a.exe", c.admin)  # no body / Content-Length 0 is fine
    assert st == 200 and out["size"] == 0


def run_cli(*args):
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = main(list(args))
    return code, json.loads(buf.getvalue().strip().splitlines()[-1])


def test_cli(tmp_path):
    data = str(tmp_path / "data")
    code, out = run_cli("init", "--data-dir", data, "--json")
    assert code == 0 and out["adminToken"].startswith("fs_")
    code, out = run_cli("init", "--data-dir", data, "--json")
    assert out["adminToken"] is None
    code, out = run_cli("create-user", "ana", "--data-dir", data, "--json")
    assert out["user"]["role"] == "user" and out["token"].startswith("fs_")
    code, out = run_cli("create-user", "ana", "--data-dir", data, "--json")
    assert code == 1 and out["code"] == "conflict"
    code, out = run_cli("import-marketplace", str(REPO / "marketplace-example"), "--owner", "ana", "--data-dir", data, "--json")
    assert code == 0 and len(out["imported"]) == 3
    rel = tmp_path / "release"
    rel.mkdir()
    (rel / "TheFlashMaster-1.0.0-x64-setup.exe").write_bytes(b"setup")
    (rel / "latest.json").write_text("{}")
    code, out = run_cli("publish-release", str(rel), "--version", "1.0.0", "--channel", "beta", "--notes", "n", "--data-dir", data, "--json")
    assert code == 0 and out["channel"] == "beta" and out["published"]
    manifest = json.loads((tmp_path / "data" / "releases" / "1.0.0" / "latest.json").read_text())
    assert manifest["files"][0]["sha256"] == hashlib.sha256(b"setup").hexdigest()
    code, out = run_cli("rebuild-index", "--data-dir", data, "--json")
    assert out["plugins"] == 3 and out["missing"] == []
    backup = tmp_path / "b.tar.gz"
    code, out = run_cli("backup", str(backup), "--data-dir", data, "--json")
    assert code == 0 and backup.is_file()
    # restore into a fresh dir and into the same dir after damage
    code, out = run_cli("restore", str(backup), "--data-dir", str(tmp_path / "other"), "--json")
    assert out["plugins"] == 3 and out["releases"] == {"stable": None, "beta": "1.0.0"}
    (tmp_path / "data" / "marketplace" / "index.json").unlink()
    code, out = run_cli("restore", str(backup), "--data-dir", data, "--json")
    assert code == 0 and (tmp_path / "data" / "marketplace" / "index.json").is_file()
    # config file + `--config` after the command
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"dataDir": data, "name": "Cfg"}))
    code, out = run_cli("rebuild-index", "--config", str(cfg), "--json")
    assert code == 0


def test_restore_rejects_unsafe_archive(tmp_path):
    import tarfile
    evil = tmp_path / "evil.tar.gz"
    with tarfile.open(evil, "w:gz") as tar:
        info = tarfile.TarInfo("../escape.txt")
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    code, out = run_cli("restore", str(evil), "--data-dir", str(tmp_path / "d"), "--json")
    assert code == 1 and not (tmp_path / "escape.txt").exists()
