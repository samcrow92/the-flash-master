"""SshSession against an in-process paramiko server: auth, exec streaming, sudo password on stdin, host keys."""
import socket
import threading

import pytest

paramiko = pytest.importorskip("paramiko")

from flashadmin.profiles import Profile  # noqa: E402
from flashadmin.ssh import HostKeyChanged, SshSession  # noqa: E402


class Server(paramiko.ServerInterface):
    def __init__(self):
        self.event = threading.Event()
        self.command = b""

    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ("mari", "pw") else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        self.command = command
        self.event.set()
        return True


def serve(host_key, results):
    lsock = socket.socket()
    lsock.bind(("127.0.0.1", 0))
    lsock.listen(1)
    port = lsock.getsockname()[1]

    def run():
        conn, _ = lsock.accept()
        t = paramiko.Transport(conn)
        t.add_server_key(host_key)
        srv = Server()
        try:
            t.start_server(server=srv)
        except Exception:
            return
        chan = t.accept(10)
        if chan is None:
            return
        srv.event.wait(10)
        results["command"] = srv.command.decode()
        if srv.command.startswith(b"sudo -S"):
            results["stdin"] = chan.makefile("rb").readline()
        chan.sendall(b"line one\nline two\n{\"ok\": true}")
        chan.send_exit_status(3)
        chan.close()
        t.close()

    threading.Thread(target=run, daemon=True).start()
    return port


def test_exec_streams_lines_and_feeds_sudo_password(tmp_path):
    key = paramiko.RSAKey.generate(1024)
    results = {}
    port = serve(key, results)
    prof = Profile(host="127.0.0.1", port=port, user="mari", auth="password", password="pw")
    s = SshSession(prof, known_hosts=str(tmp_path / "known_hosts"))
    s.connect(timeout=10)
    assert s.host_key_warning and "accepted host key" in s.host_key_warning
    lines = []
    code, out = s.exec("systemctl restart flash-server", sudo=True, on_line=lines.append)
    s.close()
    assert code == 3
    assert lines == ["line one", "line two", '{"ok": true}']
    assert results["command"].startswith("sudo -S -p ''")
    assert results["stdin"] == b"pw\n"


def test_changed_host_key_is_refused(tmp_path):
    kh = str(tmp_path / "known_hosts")
    port = serve(paramiko.RSAKey.generate(1024), {})
    prof = Profile(host="127.0.0.1", port=port, user="mari", auth="password", password="pw")
    s = SshSession(prof, known_hosts=kh)
    s.connect(timeout=10)
    s.close()
    # same address, new key
    hk = paramiko.HostKeys(kh)
    entry = hk.lookup(f"[127.0.0.1]:{port}")
    assert entry is not None
    port2 = serve(paramiko.RSAKey.generate(1024), {})
    with open(kh) as fh:
        text = fh.read().replace(f"[127.0.0.1]:{port}", f"[127.0.0.1]:{port2}")
    with open(kh, "w") as fh:
        fh.write(text)
    s2 = SshSession(Profile(host="127.0.0.1", port=port2, user="mari", auth="password", password="pw"), known_hosts=kh)
    with pytest.raises(HostKeyChanged):
        s2.connect(timeout=10)
