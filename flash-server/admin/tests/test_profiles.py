import json
import os
import stat
import sys

from flashadmin.profiles import Profile, ProfileStore, SecretStore


class DictKeyring(SecretStore):
    def __init__(self):
        self.data = {}

    @property
    def available(self):
        return True

    def get(self, pid, name):
        return self.data.get((pid, name), "")

    def set(self, pid, name, value):
        if value:
            self.data[(pid, name)] = value
        else:
            self.data.pop((pid, name), None)
        return True


def test_round_trip_without_keyring_keeps_secrets_in_file(tmp_path):
    path = tmp_path / "profiles.json"
    store = ProfileStore(str(path), SecretStore(use_keyring=False))
    assert store.secrets_in_file
    p = Profile(name="box", host="h", port=2222, user="mari", auth="password", password="pw", admin_token="fs_x")
    store.upsert(p)
    store.last_used = p.id
    store.save()
    raw = json.loads(path.read_text())
    assert "password" not in raw["profiles"][0]
    assert raw["secrets"][p.id] == {"password": "pw", "admin_token": "fs_x"}
    assert "_warning" in raw
    if sys.platform != "win32":
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    again = ProfileStore(str(path), SecretStore(use_keyring=False))
    loaded = again.load()[0]
    assert loaded == p and again.last_used == p.id
    assert loaded.sudo_secret() == "pw"


def test_keyring_keeps_secrets_out_of_file(tmp_path):
    path = tmp_path / "profiles.json"
    kr = DictKeyring()
    store = ProfileStore(str(path), kr)
    p = Profile(host="h", password="pw", sudo_password="s", sudo_same_password=False, admin_token="t")
    store.upsert(p)
    store.save()
    raw = json.loads(path.read_text())
    assert "secrets" not in raw and "pw" not in path.read_text()
    loaded = ProfileStore(str(path), kr).load()[0]
    assert loaded.sudo_secret() == "s" and loaded.admin_token == "t"
    store.remove(p.id)
    assert kr.data == {}


def test_profile_helpers():
    p = Profile(host="srv", user="u", port=22, server_port=8787)
    assert p.display_target() == "u@srv"
    assert p.client_url() == "http://srv:8787"
    p.public_url = "https://x.example/"
    assert p.client_url() == "https://x.example"
    assert Profile.from_dict({"host": "a", "port": "2200", "junk": 1}).port == 2200
