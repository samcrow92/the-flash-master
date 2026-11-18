"""Pure HTTP client for the Flash Server API (flash-server/API.md). Stdlib only, no Qt."""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, BinaryIO, Callable, Optional

ProgressFn = Callable[[int, int], None]


class ApiError(Exception):
    """An HTTP or network error, with the server's `{error, code}` when it sent one."""

    def __init__(self, message: str, status: int = 0, code: str = "network"):
        super().__init__(message)
        self.status = status
        self.code = code

    def __str__(self) -> str:  # compact, banner friendly
        msg = self.args[0] if self.args else "error"
        return f"{msg} ({self.status} {self.code})" if self.status else msg


def _q(part: Any) -> str:
    return urllib.parse.quote(str(part), safe="")


class _ProgressReader:
    """File-like wrapper urllib can stream from, reporting bytes sent."""

    def __init__(self, fh: BinaryIO, total: int, progress: Optional[ProgressFn]):
        self._fh, self._total, self._progress, self._sent = fh, total, progress, 0

    def read(self, size: int = -1) -> bytes:
        chunk = self._fh.read(256 * 1024 if size is None or size < 0 else size)
        self._sent += len(chunk)
        if self._progress:
            self._progress(self._sent, self._total)
        return chunk

    def __len__(self) -> int:
        return self._total


def sha256_file(path: str, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


class ApiClient:
    def __init__(self, base_url: str, token: str = "", timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    # ------------------------------------------------------------------ core
    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {"Accept": "application/json", "User-Agent": "flash-admin"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if extra:
            h.update(extra)
        return h

    def request(self, method: str, path: str, body: Any = None, *, query: Optional[dict] = None,
                data: Any = None, headers: Optional[dict] = None, timeout: Optional[float] = None) -> Any:
        url = self.base_url + path
        if query:
            q = {k: v for k, v in query.items() if v is not None and v != ""}
            if q:
                url += "?" + urllib.parse.urlencode(q)
        hdrs = self._headers(headers)
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raw = b""
            try:
                raw = e.read()
            except Exception:
                pass
            message, code = e.reason or "HTTP error", "http"
            try:
                payload = json.loads(raw.decode("utf-8"))
                message = payload.get("error") or message
                code = payload.get("code") or code
            except Exception:
                pass
            raise ApiError(str(message), e.code, str(code)) from None
        except urllib.error.URLError as e:
            raise ApiError(f"Cannot reach {self.base_url}: {e.reason}") from None
        except (TimeoutError, OSError) as e:
            raise ApiError(f"Cannot reach {self.base_url}: {e}") from None
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError("Server sent a non-JSON response", 0, "invalid_response") from None

    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, **kw)

    # --------------------------------------------------------------- account
    def health(self) -> dict:
        return self.get("/api/v1/health")

    def me(self) -> dict:
        return self.get("/api/v1/me")

    # ----------------------------------------------------------------- admin
    def stats(self) -> dict:
        return self.get("/api/v1/admin/stats")

    def submissions(self, status: str = "pending") -> list:
        return self.get("/api/v1/admin/submissions", query={"status": status})["submissions"]

    def submission(self, sid: int) -> dict:
        return self.get(f"/api/v1/admin/submissions/{_q(sid)}")

    def review(self, sid: int, decision: str, feedback: str = "") -> dict:
        if decision not in ("approve", "reject", "changes_requested"):
            raise ValueError(f"unknown decision {decision!r}")
        if decision != "approve" and not feedback.strip():
            raise ValueError("Feedback is required to reject or request changes")
        return self.request("POST", f"/api/v1/admin/submissions/{_q(sid)}/review",
                            {"decision": decision, "feedback": feedback})

    def plugins(self) -> list:
        return self.get("/api/v1/admin/plugins")["plugins"]

    def unpublish(self, plugin_id: str, version: Optional[str] = None) -> dict:
        path = f"/api/v1/admin/plugins/{_q(plugin_id)}"
        if version:
            path += f"/{_q(version)}"
        return self.request("DELETE", path)

    def users(self) -> list:
        return self.get("/api/v1/admin/users")["users"]

    def create_user(self, name: str, role: str = "user") -> dict:
        return self.request("POST", "/api/v1/admin/users", {"name": name, "role": role})

    def rotate_token(self, uid: int) -> str:
        return self.request("POST", f"/api/v1/admin/users/{_q(uid)}/token")["token"]

    def update_user(self, uid: int, **fields: Any) -> dict:
        allowed = {k: v for k, v in fields.items() if k in ("disabled", "role")}
        return self.request("PATCH", f"/api/v1/admin/users/{_q(uid)}", allowed)

    def delete_user(self, uid: int) -> dict:
        return self.request("DELETE", f"/api/v1/admin/users/{_q(uid)}")

    # -------------------------------------------------------------- releases
    def releases(self) -> dict:
        return self.get("/api/v1/admin/releases")

    def upload_release_file(self, version: str, path: str, *, name: Optional[str] = None,
                            sha256: Optional[str] = None, progress: Optional[ProgressFn] = None) -> dict:
        name = name or os.path.basename(path)
        digest = sha256 or sha256_file(path)
        size = os.path.getsize(path)
        url = f"/api/v1/admin/releases/{_q(version)}/files/{_q(name)}"
        with open(path, "rb") as fh:
            reader = _ProgressReader(fh, size, progress)
            return self.request("PUT", url, query={"sha256": digest}, data=reader,
                                headers={"Content-Type": "application/octet-stream",
                                         "Content-Length": str(size)},
                                timeout=max(self.timeout, 600))

    def publish_release(self, version: str, channel: str, notes: str = "") -> dict:
        return self.request("POST", f"/api/v1/admin/releases/{_q(version)}/publish",
                            {"channel": channel, "notes": notes})

    def promote_release(self, version: str, channel: str = "stable") -> dict:
        return self.request("POST", f"/api/v1/admin/releases/{_q(version)}/promote", {"channel": channel})

    def delete_release(self, version: str) -> dict:
        return self.request("DELETE", f"/api/v1/admin/releases/{_q(version)}")
