"""scripts/release.py → flash-server: the publish helper uploads a build folder and the feed serves what the app's updater reads."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


publisher = _load("publish_release", REPO / "flash-server" / "tools" / "publish_release.py")
release = _load("release_script", REPO / "scripts" / "release.py")


def _build(folder: Path, version: str) -> dict:
    folder.mkdir()
    files = {f"TheFlashMaster-{version}-x64-setup.exe": b"setup" * 1000, f"TheFlashMaster-{version}-x64-portable.exe": b"port" * 900,
             "TheFlashMaster-0.0.1-x64-setup.exe": b"old build, must not be sent", "builder-debug.yml": b"x"}
    for n, b in files.items():
        (folder / n).write_bytes(b)
    return files


def test_publish_uploads_this_versions_files_and_serves_the_feed(server, tmp_path):
    url = f"http://127.0.0.1:{server.port}"
    files = _build(tmp_path / "release", "0.5.0")
    assert publisher.current_versions(url, server.admin) == {"stable": None, "beta": None}
    publisher.publish(url, server.admin, tmp_path / "release", "0.5.0", "stable", "Notes", log=lambda *_: None)
    assert publisher.current_versions(url, server.admin)["stable"] == "0.5.0"

    status, manifest = server.req("GET", "/updates/stable/latest.json", token=server.admin)
    assert status == 200 and manifest["version"] == "0.5.0" and manifest["notes"] == "Notes"
    by_kind = {f["kind"]: f for f in manifest["files"]}
    assert set(by_kind) == {"setup", "portable"}
    for f in manifest["files"]:  # what src/main/updater.ts verifies after downloading
        status, body = server.req("GET", f"/updates/stable/{f['name']}", token=server.admin)
        assert status == 200 and body == files[f["name"]]
        assert f["sha256"] == hashlib.sha256(body).hexdigest() and f["size"] == len(body)


def test_publish_reports_a_wrong_token_clearly(server, tmp_path):
    _build(tmp_path / "release", "0.5.0")
    with pytest.raises(publisher.PublishError, match="401"):
        publisher.publish(f"http://127.0.0.1:{server.port}", "fs_wrong", tmp_path / "release", "0.5.0", log=lambda *_: None)


def test_publish_needs_a_build():
    with pytest.raises(publisher.PublishError, match="No 9.9.9 .exe"):
        publisher.release_files(REPO / "flash-server", "9.9.9")


def test_release_script_targets():
    p = release.build_parser()
    assert release.release_targets(p.parse_args(["--server", ""])) == (True, False)
    assert release.release_targets(p.parse_args(["--server", "http://x"])) == (True, True)
    assert release.release_targets(p.parse_args(["--server", "http://x", "--target", "server"])) == (False, True)
    with pytest.raises(release.ReleaseError):
        release.release_targets(p.parse_args(["--server", "", "--target", "server"]))
    assert json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]
