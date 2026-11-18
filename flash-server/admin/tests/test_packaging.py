import os
import tarfile

import pytest

from flashadmin import packaging


def make_root(tmp_path):
    root = tmp_path / "flash-server"
    (root / "server" / "flashserver" / "__pycache__").mkdir(parents=True)
    (root / "server" / "flashserver" / "__init__.py").write_bytes(b"x = 1\r\n")
    (root / "server" / "flashserver" / "__pycache__" / "a.pyc").write_bytes(b"\0")
    (root / "server" / "tests").mkdir()
    (root / "server" / "tests" / "test_x.py").write_text("")
    (root / "deploy").mkdir()
    (root / "deploy" / "install.sh").write_bytes(b"#!/bin/bash\r\necho hi\r\n")
    (root / "deploy" / "flash-server.service").write_text("[Unit]\n")
    (root / "admin").mkdir()
    (root / "admin" / "secret.txt").write_text("no")
    return root


def test_bundle_contents(tmp_path):
    root = make_root(tmp_path)
    out = tmp_path / "b.tar.gz"
    names = packaging.build_bundle(str(root), str(out))
    assert names == ["server/flashserver/__init__.py", "deploy/flash-server.service", "deploy/install.sh"] or \
        sorted(names) == sorted(["server/flashserver/__init__.py", "deploy/flash-server.service", "deploy/install.sh"])
    with tarfile.open(out) as tar:
        members = {m.name: m for m in tar.getmembers()}
        assert set(members) == set(names)
        assert members["deploy/install.sh"].mode == 0o755
        assert members["server/flashserver/__init__.py"].mode == 0o644
        assert tar.extractfile("deploy/install.sh").read() == b"#!/bin/bash\necho hi\n"  # CRLF fixed


def test_bundle_rejects_wrong_folder(tmp_path):
    with pytest.raises(FileNotFoundError):
        packaging.build_bundle(str(tmp_path), str(tmp_path / "x.tgz"))


def test_find_root(tmp_path):
    root = make_root(tmp_path)
    assert packaging.find_flash_server_root(str(root / "admin")) == str(root)
    assert packaging.find_flash_server_root(str(tmp_path)) == str(root)


def test_parse_last_json():
    assert packaging.parse_last_json('step 1\nstep 2\n{"adminToken": "fs_abc"}\n\n') == {"adminToken": "fs_abc"}
    assert packaging.parse_last_json("no json\nfinal words") is None
    # Seen on a real Ubuntu deploy: install.sh's stderr log line arrived after the token line over SSH.
    out = '==> waiting\n{"adminToken": "fs_abc"}\n==> flash-server is running (journalctl -u flash-server -f for logs)\n'
    assert packaging.parse_last_json(out) == {"adminToken": "fs_abc"}
    assert packaging.parse_last_json("") is None
    assert packaging.parse_last_json("[1,2]") is None


def test_scan_release_folder(tmp_path):
    for n in ("TheFlashMaster-0.6.0-beta.3-x64-setup.exe", "SHA256SUMS.txt", "latest.json", "bad name.exe"):
        (tmp_path / n).write_text("x")
    scan = packaging.scan_release_folder(str(tmp_path))
    assert scan["version"] == "0.6.0-beta.3"
    assert scan["files"] == ["TheFlashMaster-0.6.0-beta.3-x64-setup.exe", "SHA256SUMS.txt", "latest.json"]
    (tmp_path / "latest.json").write_text('{"version": "0.6.0", "notes": "hi"}')
    scan = packaging.scan_release_folder(str(tmp_path))
    assert (scan["version"], scan["notes"]) == ("0.6.0", "hi")


def test_human():
    assert packaging.human_size(512) == "512 B"
    assert packaging.human_size(1536) == "1.5 KB"
    assert packaging.human_duration(3 * 86400 + 7200) == "3d 2h"


def test_marketplace_files_bring_attachments(tmp_path):
    # Seen on a real deploy: importing only plugins-src lost the EXAM attachment in the sibling files/ folder.
    (tmp_path / "plugins-src" / "p").mkdir(parents=True)
    (tmp_path / "plugins-src" / "p" / "plugin.json").write_text("{}")
    (tmp_path / "files").mkdir()
    (tmp_path / "files" / "a.jar").write_text("x")
    (tmp_path / "index.json").write_text("{}")
    want = ["files/a.jar", "plugins-src/p/plugin.json"]
    for picked in (tmp_path, tmp_path / "plugins-src"):
        assert sorted(rel for _, rel in packaging.marketplace_files(str(picked))) == want
    assert [rel for _, rel in packaging.marketplace_files(str(tmp_path / "plugins-src" / "p"))] == ["plugins-src/plugin.json"]
