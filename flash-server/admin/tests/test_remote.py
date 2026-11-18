from flashadmin import remote


def test_install_command_flags():
    cmd = remote.install_command("/tmp/x y", "b.tgz", 9000, True, True)
    assert cmd == "cd '/tmp/x y' && tar xzf b.tgz && bash deploy/install.sh --host 0.0.0.0 --port 9000 --open-firewall"
    assert remote.install_command("/tmp/x", "b.tgz").endswith("bash deploy/install.sh")


def test_sudo_wrap():
    assert remote.sudo("echo 'a'", True) == "sudo -S -p '' bash -c 'echo '\"'\"'a'\"'\"''"
    assert remote.sudo("id", False, "flash") == "sudo -n -u flash bash -c id"


def test_cli_command():
    cmd = remote.cli("backup", "/var/lib/flash-server/backups/b.tar.gz")
    assert "python3 -m flashserver backup /var/lib/flash-server/backups/b.tar.gz" in cmd
    assert cmd.endswith("--config /etc/flash-server/config.json --json")


def test_prereqs_and_status():
    out = "PY=3.12.3\nOS=Ubuntu 24.04 LTS\nSYSTEMD=255\nDISK=5000000000\nTMP=100\nSUDO=password"
    checks = {c["name"]: c for c in remote.evaluate_prereqs(out)}
    assert checks["Python 3.10+"]["ok"] and checks["systemd"]["ok"]
    assert checks["Free disk (/var/lib)"]["ok"] and not checks["Free disk (/tmp)"]["ok"]
    assert not {c["name"]: c for c in remote.evaluate_prereqs("PY=3.8.10")}["Python 3.10+"]["ok"]
    st = remote.parse_status("ActiveState=active\nSubState=running\nMainPID=812\nLoadState=loaded")
    assert st["active"] == "active" and st["pid"] == "812"


def test_systemctl_validates():
    import pytest

    assert remote.systemctl("restart") == "systemctl restart flash-server"
    with pytest.raises(ValueError):
        remote.systemctl("rm -rf")
