import socket
import threading
import urllib.request

import pytest

paramiko = pytest.importorskip("paramiko")

from flashadmin.ssh import Tunnel, _FirstUsePolicy, fingerprint  # noqa: E402


class FakeTransport:
    """open_channel returns a socket whose peer answers like a tiny HTTP server."""

    def __init__(self):
        self.opened = []

    def open_channel(self, kind, dest, src, timeout=None):
        self.opened.append((kind, dest))
        a, b = socket.socketpair()

        def serve():
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = b.recv(4096)
                if not chunk:
                    return
                data += chunk
            body = b'{"ok": true}'
            b.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
                      b"Connection: close\r\n\r\n%s" % (len(body), body))
            b.close()

        threading.Thread(target=serve, daemon=True).start()
        return a


def test_tunnel_forwards_to_remote_port():
    t = FakeTransport()
    tun = Tunnel(t, 8787)
    try:
        with urllib.request.urlopen(tun.url + "/api/v1/health", timeout=5) as r:
            assert r.read() == b'{"ok": true}'
        assert t.opened == [("direct-tcpip", ("127.0.0.1", 8787))]
    finally:
        tun.close()


def test_first_use_policy_saves_key(tmp_path):
    key = paramiko.RSAKey.generate(1024)
    client = paramiko.SSHClient()
    path = tmp_path / "known_hosts"
    pol = _FirstUsePolicy(str(path))
    pol.missing_host_key(client, "[box]:2222", key)
    assert pol.accepted.endswith(fingerprint(key))
    hk = paramiko.HostKeys(str(path))
    assert hk.lookup("[box]:2222") is not None
