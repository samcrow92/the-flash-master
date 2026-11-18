import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from flashadmin.api import ApiClient, ApiError


class Fake:
    requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _record(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        Fake.requests.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"),
                              "ctype": self.headers.get("Content-Type"), "body": body})
        return body

    def do_GET(self):
        self._record()
        if self.headers.get("Authorization") != "Bearer fs_good":
            return self._reply(401, {"error": "bad token", "code": "unauthorized"})
        if self.path == "/api/v1/admin/stats":
            return self._reply(200, {"users": 3, "plugins": 1})
        if self.path.startswith("/api/v1/admin/submissions?"):
            return self._reply(200, {"submissions": [{"id": 1, "status": "pending"}]})
        if self.path == "/api/v1/admin/submissions/7":
            return self._reply(200, {"id": 7, "diff": {"previousVersion": None, "files": []}})
        self._reply(404, {"error": "nope", "code": "not_found"})

    def do_POST(self):
        body = self._record()
        if self.path == "/api/v1/admin/users":
            return self._reply(200, {"user": {"id": 9, **json.loads(body)}, "token": "fs_new"})
        if self.path.endswith("/review"):
            return self._reply(200, {"id": 7, "status": "approved"})
        if self.path.endswith("/publish"):
            return self._reply(409, {"error": "no exe", "code": "conflict"})
        self._reply(404, {"error": "nope", "code": "not_found"})

    def do_PUT(self):
        body = self._record()
        self._reply(200, {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()})

    def do_PATCH(self):
        body = self._record()
        self._reply(200, json.loads(body))

    def do_DELETE(self):
        self._record()
        self._reply(200, {"ok": True})


@pytest.fixture
def server():
    Fake.requests = []
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def test_get_with_bearer_token(server):
    api = ApiClient(server, "fs_good")
    assert api.stats()["users"] == 3
    assert Fake.requests[-1]["auth"] == "Bearer fs_good"


def test_errors_carry_status_and_code(server):
    with pytest.raises(ApiError) as e:
        ApiClient(server, "fs_bad").stats()
    assert e.value.status == 401 and e.value.code == "unauthorized" and "bad token" in str(e.value)
    with pytest.raises(ApiError) as e:
        ApiClient(server, "fs_good").publish_release("1.0.0", "stable")
    assert e.value.code == "conflict"


def test_network_error_is_api_error():
    with pytest.raises(ApiError) as e:
        ApiClient("http://127.0.0.1:1", "x", timeout=2).health()
    assert e.value.code == "network"


def test_submissions_query_and_detail(server):
    api = ApiClient(server, "fs_good")
    assert api.submissions("pending")[0]["id"] == 1
    assert Fake.requests[-1]["path"] == "/api/v1/admin/submissions?status=pending"
    assert api.submission(7)["diff"]["files"] == []


def test_review_requires_feedback_for_reject(server):
    api = ApiClient(server, "fs_good")
    with pytest.raises(ValueError):
        api.review(7, "reject", "  ")
    with pytest.raises(ValueError):
        api.review(7, "maybe")
    assert api.review(7, "approve")["status"] == "approved"
    assert json.loads(Fake.requests[-1]["body"]) == {"decision": "approve", "feedback": ""}
    assert Fake.requests[-1]["ctype"].startswith("application/json")


def test_users_crud(server):
    api = ApiClient(server, "fs_good")
    res = api.create_user("ana", "user")
    assert res["token"] == "fs_new" and res["user"]["name"] == "ana"
    assert api.update_user(9, disabled=True, bogus=1) == {"disabled": True}
    assert api.delete_user(9) == {"ok": True}
    assert Fake.requests[-1]["method"] == "DELETE" and Fake.requests[-1]["path"] == "/api/v1/admin/users/9"


def test_unpublish_paths(server):
    api = ApiClient(server, "fs_good")
    api.unpublish("my-plugin", "1.0.0")
    assert Fake.requests[-1]["path"] == "/api/v1/admin/plugins/my-plugin/1.0.0"
    api.unpublish("my-plugin")
    assert Fake.requests[-1]["path"] == "/api/v1/admin/plugins/my-plugin"


def test_release_upload_streams_with_sha(server, tmp_path):
    f = tmp_path / "TheFlashMaster-1.0.0-x64-setup.exe"
    data = b"MZ" + bytes(range(256)) * 2000
    f.write_bytes(data)
    seen = []
    res = ApiClient(server, "fs_good").upload_release_file("1.0.0", str(f), progress=lambda a, b: seen.append((a, b)))
    digest = hashlib.sha256(data).hexdigest()
    assert res == {"size": len(data), "sha256": digest}
    req = Fake.requests[-1]
    assert req["path"] == f"/api/v1/admin/releases/1.0.0/files/{f.name}?sha256={digest}"
    assert req["ctype"] == "application/octet-stream"
    assert seen[-1] == (len(data), len(data))
