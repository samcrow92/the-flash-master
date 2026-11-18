"""HTTP layer: routing, auth, JSON bodies, static feed/marketplace files, one log line per request."""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .core import Service
from .util import ID_RE, NAME_RE, VERSION_RE, ApiError, bad, forbidden, json_bytes, not_found, safe_join

MAX_JSON = 2 * 1024 * 1024
ROUTES: list[tuple[str, tuple[str, ...], str, str]] = []  # method, segment patterns, handler, access


def route(method: str, path: str, access: str = "user"):
    """Register a handler. `{name}` segments are captured; access: public | read | user | admin."""
    def deco(fn):
        ROUTES.append((method, tuple(path.strip("/").split("/")), fn.__name__, access))
        return fn
    return deco


class FileBody:
    def __init__(self, path: Path, ctype: str, download: bool = False):
        self.path, self.ctype, self.download = path, ctype, download


def _int(v: str) -> int:
    if not v.isdigit() or len(v) > 12:
        raise not_found()
    return int(v)


class Handlers:
    """Route handlers: (self=api, h=request handler, user, params, query, body) -> (status, obj) | FileBody."""

    def __init__(self, svc: Service):
        self.svc = svc

    # ----- compatible static routes -----
    @route("GET", "updates/latest.json", "read")
    def feed_latest_alias(self, h, user, p):
        return FileBody(self.svc.feed_manifest("stable"), "application/json; charset=utf-8")

    @route("GET", "updates/{channel}/{name}", "read")
    def feed_file(self, h, user, p):
        if p["channel"] not in ("stable", "beta"):
            raise not_found()
        if p["name"] == "latest.json":
            return FileBody(self.svc.feed_manifest(p["channel"]), "application/json; charset=utf-8")
        return FileBody(self.svc.feed_file(p["channel"], p["name"]), "application/octet-stream", download=True)

    @route("GET", "marketplace/index.json", "read")
    def market_index(self, h, user, p):
        return FileBody(self.svc.data / "marketplace" / "index.json", "application/json; charset=utf-8")

    @route("GET", "marketplace/plugins/{file}", "read")
    def market_package(self, h, user, p):
        f = p["file"]
        if not f.endswith(".json") or not NAME_RE.match(f.replace("+", "_")) or f.startswith("."):
            raise not_found()
        path = safe_join(self.svc.data / "marketplace" / "plugins", f)
        if not path.is_file():
            raise not_found()
        return FileBody(path, "application/json; charset=utf-8")

    @route("GET", "marketplace/files/{name}", "read")
    def market_file(self, h, user, p):
        n = p["name"]
        if not NAME_RE.match(n) or n.startswith("."):
            raise not_found()
        path = safe_join(self.svc.data / "marketplace" / "files", n)
        if not path.is_file():
            raise not_found()
        return FileBody(path, "application/octet-stream", download=True)

    # ----- account -----
    @route("GET", "api/v1/health", "public")
    def health(self, h, user, p):
        return 200, self.svc.health()

    @route("GET", "api/v1/me")
    def me(self, h, user, p):
        return 200, {"id": user["id"], "name": user["name"], "role": user["role"]}

    # ----- submissions -----
    @route("POST", "api/v1/submissions")
    def submit(self, h, user, p):
        return self.svc.submit(user, h.json_body())

    @route("GET", "api/v1/submissions")
    def my_submissions(self, h, user, p):
        return 200, {"submissions": self.svc.submissions(user)}

    @route("GET", "api/v1/submissions/{id}")
    def my_submission(self, h, user, p):
        return 200, self.svc.submission(user, _int(p["id"]))

    @route("DELETE", "api/v1/submissions/{id}")
    def withdraw(self, h, user, p):
        return 200, self.svc.withdraw(user, _int(p["id"]))

    # ----- admin -----
    @route("GET", "api/v1/admin/stats", "admin")
    def stats(self, h, user, p):
        return 200, self.svc.stats()

    @route("GET", "api/v1/admin/submissions", "admin")
    def all_submissions(self, h, user, p):
        return 200, {"submissions": self.svc.submissions(None, h.query.get("status"))}

    @route("GET", "api/v1/admin/submissions/{id}", "admin")
    def admin_submission(self, h, user, p):
        return 200, self.svc.submission(user, _int(p["id"]), admin_view=True)

    @route("POST", "api/v1/admin/submissions/{id}/review", "admin")
    def review(self, h, user, p):
        return 200, self.svc.review(user, _int(p["id"]), h.json_body())

    @route("GET", "api/v1/admin/plugins", "admin")
    def plugins(self, h, user, p):
        return 200, {"plugins": self.svc.plugins()}

    @route("DELETE", "api/v1/admin/plugins/{pid}", "admin")
    def unpublish_all(self, h, user, p):
        if not ID_RE.match(p["pid"]):
            raise not_found()
        self.svc.unpublish(p["pid"])
        return 200, {"ok": True}

    @route("DELETE", "api/v1/admin/plugins/{pid}/{version}", "admin")
    def unpublish_version(self, h, user, p):
        if not ID_RE.match(p["pid"]) or not VERSION_RE.match(p["version"]):
            raise not_found()
        self.svc.unpublish(p["pid"], p["version"])
        return 200, {"ok": True}

    @route("GET", "api/v1/admin/users", "admin")
    def users(self, h, user, p):
        return 200, {"users": self.svc.users()}

    @route("POST", "api/v1/admin/users", "admin")
    def create_user(self, h, user, p):
        b = h.json_body()
        u, token = self.svc.create_user(b.get("name"), b.get("role") or "user")
        return 201, {"user": u, "token": token}

    @route("POST", "api/v1/admin/users/{id}/token", "admin")
    def rotate(self, h, user, p):
        return 200, {"token": self.svc.rotate_token(_int(p["id"]))}

    @route("PATCH", "api/v1/admin/users/{id}", "admin")
    def update_user(self, h, user, p):
        return 200, self.svc.update_user(_int(p["id"]), h.json_body())

    @route("DELETE", "api/v1/admin/users/{id}", "admin")
    def delete_user(self, h, user, p):
        self.svc.delete_user(_int(p["id"]))
        return 200, {"ok": True}

    @route("GET", "api/v1/admin/releases", "admin")
    def releases(self, h, user, p):
        return 200, self.svc.releases()

    @route("PUT", "api/v1/admin/releases/{version}/files/{name}", "admin")
    def upload(self, h, user, p):
        length = h.headers.get("Content-Length")
        if length is None or not length.isdigit():
            raise ApiError(411, "invalid", "Content-Length is required (chunked uploads are not supported)")
        sha = h.query.get("sha256") or None
        h.body_consumed = True  # the stream is read (or abandoned) here
        out = self.svc.upload_release_file(p["version"], p["name"], h.rfile, int(length), sha)
        return 200, out

    @route("POST", "api/v1/admin/releases/{version}/publish", "admin")
    def publish(self, h, user, p):
        return 200, self.svc.publish_release(p["version"], h.json_body())

    @route("POST", "api/v1/admin/releases/{version}/promote", "admin")
    def promote(self, h, user, p):
        return 200, self.svc.promote_release(p["version"], h.json_body())

    @route("DELETE", "api/v1/admin/releases/{version}", "admin")
    def delete_release(self, h, user, p):
        self.svc.delete_release(p["version"])
        return 200, {"ok": True}


def match(method: str, segs: list[str]):
    """Return (handler name, access, params) for the first matching route, or None. Unknown method on a known path → 405."""
    path_hit = False
    for m, pat, name, access in ROUTES:
        if len(pat) != len(segs):
            continue
        params = {}
        for ps, s in zip(pat, segs):
            if ps.startswith("{"):
                params[ps[1:-1]] = s
            elif ps != s:
                break
        else:
            if m == method:
                return name, access, params
            path_hit = True
    if path_hit:
        raise ApiError(405, "invalid", "method not allowed")
    return None


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive + "Expect: 100-continue" for uploads
    timeout = 120  # idle keep-alive connections and stalled uploads are dropped
    api: Handlers  # set on the subclass by make_server
    quiet = False

    def json_body(self) -> dict:
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(411, "invalid", "send a Content-Length (chunked bodies are not supported)")
        self.body_consumed = True
        length = self.headers.get("Content-Length")
        n = int(length) if length and length.isdigit() else 0
        if n > MAX_JSON:
            if n <= 8 * MAX_JSON:  # drain a moderately oversized body so the client can read the 413
                left = n
                while left > 0:
                    b = self.rfile.read(min(left, 1 << 16))
                    if not b:
                        break
                    left -= len(b)
            raise ApiError(413, "too_large", "request body is larger than 2 MB")
        raw = self.rfile.read(n) if n else b""
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise bad("body is not valid JSON", 400) from None
        if not isinstance(body, dict):
            raise bad("body must be a JSON object", 400)
        return body

    def _dispatch(self, method: str) -> None:
        t0, self.status, self.sent, self.who = time.time(), 0, 0, "-"
        self.body_consumed = False
        try:
            u = urlsplit(self.path)
            self.query = {k: v[0] for k, v in parse_qs(u.query).items()}
            raw = u.path
            if "\\" in raw or "\x00" in raw or len(raw) > 1024:
                raise bad("bad path", 400)
            segs = [unquote(s) for s in raw.strip("/").split("/")] if raw.strip("/") else []
            if any(s in ("", ".", "..") or "/" in s or "\\" in s or "\x00" in s for s in segs):
                raise bad("bad path", 400)
            hit = match(method, segs)
            if not hit:
                raise not_found()
            name, access, params = hit
            user = self.api.svc.authenticate(self.headers.get("Authorization"))
            if user is not None:
                self.who = user["name"]
            if user is None and not (access == "public" or (access == "read" and self.api.svc.config.get("publicRead"))):
                raise ApiError(401, "unauthorized", "a valid token is required")
            if access == "admin" and user["role"] != "admin":
                raise forbidden("admin only")
            res = getattr(self.api, name)(self, user, params)
            if isinstance(res, FileBody):
                self._send_file(res)
            else:
                self._send_json(res[0], res[1])
        except ApiError as e:
            # a request body may be unread or half read: never reuse that connection
            self._send_json(e.status, {"error": e.message, "code": e.code}, close=method != "GET")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:  # noqa: BLE001 - last resort, keep the server alive
            traceback.print_exc(file=sys.stderr)
            try:
                self._send_json(500, {"error": "internal server error", "code": "internal"}, close=True)
            except OSError:
                pass
        finally:
            if not self.quiet:
                ip = self.client_address[0] if self.client_address else "-"
                path = self.path.split("?", 1)[0][:300]
                sys.stdout.write(f'{ip} {self.who} "{method} {path}" {self.status} {self.sent} {int((time.time() - t0) * 1000)}ms\n')
                sys.stdout.flush()

    def _headers(self, status: int, ctype: str, length: int, extra: dict | None = None) -> None:
        self.status, self.sent = status, length
        unread = self.headers.get("Transfer-Encoding") or (not self.body_consumed and self.headers.get("Content-Length", "0") not in ("", "0"))
        if unread or self.close_connection:
            extra = {**(extra or {}), "Connection": "close"}
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _send_json(self, status: int, obj, close: bool = False) -> None:
        body = json_bytes(obj)
        if close:
            self.close_connection = True
        self._headers(status, "application/json; charset=utf-8", len(body), {"Cache-Control": "no-store"})
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_file(self, f: FileBody) -> None:
        try:
            fh = open(f.path, "rb")
        except OSError:
            raise not_found() from None
        with fh:
            size = os.fstat(fh.fileno()).st_size
            extra = {"Cache-Control": "no-cache"}
            if f.download:
                extra["Content-Disposition"] = f'attachment; filename="{f.path.name}"'
            self._headers(200, f.ctype, size, extra)
            if self.command == "HEAD":
                return
            while True:
                b = fh.read(1 << 20)
                if not b:
                    break
                self.wfile.write(b)

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def version_string(self) -> str:
        return "flash-server"

    def log_message(self, format, *args):  # noqa: A002 - our own one-line log is written in _dispatch
        pass


def make_server(svc: Service, host: str, port: int, quiet: bool = False) -> ThreadingHTTPServer:
    handler = type("Handler", (RequestHandler,), {"api": Handlers(svc), "quiet": quiet})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    return srv

