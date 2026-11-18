import http.client
import json
import sys
import threading
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SERVER_DIR))

from flashserver.core import Service  # noqa: E402
from flashserver.web import make_server  # noqa: E402


class Client:
    def __init__(self, port: int, svc: Service):
        self.port, self.svc = port, svc

    def req(self, method, path, token=None, body=None, raw=None, headers=None, scheme="Bearer"):
        h = dict(headers or {})
        if token:
            h["Authorization"] = f"{scheme} {token}"
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            payload = r.read()
        finally:
            c.close()
        ctype = r.getheader("Content-Type", "")
        out = json.loads(payload) if payload and ctype.startswith("application/json") else payload
        return r.status, out


def start(tmp_path: Path, **cfg):
    config = {"dataDir": str(tmp_path / "data"), "name": "Test server", **cfg}
    svc = Service(config)
    srv = make_server(svc, "127.0.0.1", 0, quiet=True)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return svc, srv, Client(srv.server_address[1], svc)


@pytest.fixture
def server(tmp_path):
    svc, srv, client = start(tmp_path)
    _, admin_token = svc.create_user("mari", "admin")
    client.admin = admin_token
    yield client
    srv.shutdown()
    srv.server_close()
    svc.close()


@pytest.fixture
def public_server(tmp_path):
    svc, srv, client = start(tmp_path, publicRead=True)
    _, client.admin = svc.create_user("mari", "admin")
    yield client
    srv.shutdown()
    srv.server_close()
    svc.close()
