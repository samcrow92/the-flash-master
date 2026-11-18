"""Saved server profiles in ~/.flash-admin/profiles.json; secrets in the OS keyring when available."""
from __future__ import annotations

import json
import os
import stat
import uuid
from dataclasses import asdict, dataclass, field, fields
from typing import Dict, List, Optional

SECRET_FIELDS = ("password", "sudo_password", "admin_token")
KEYRING_SERVICE = "flash-admin"


def config_dir() -> str:
    return os.environ.get("FLASH_ADMIN_HOME") or os.path.join(os.path.expanduser("~"), ".flash-admin")


@dataclass
class Profile:
    name: str = "New server"
    host: str = ""
    port: int = 22
    user: str = ""
    auth: str = "key"  # "key" | "password"
    key_file: str = ""
    sudo_same_password: bool = True
    server_port: int = 8787
    public_url: str = ""
    use_tunnel: bool = True
    bind_public: bool = False
    open_firewall: bool = False
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    # secrets: never written to profiles.json when a keyring is available
    password: str = ""
    sudo_password: str = ""
    admin_token: str = ""

    def sudo_secret(self) -> str:
        """Password to feed `sudo -S` (empty = rely on NOPASSWD sudo)."""
        if self.sudo_same_password:
            return self.password
        return self.sudo_password

    def display_target(self) -> str:
        port = f":{self.port}" if self.port and self.port != 22 else ""
        return f"{self.user + '@' if self.user else ''}{self.host}{port}"

    def client_url(self) -> str:
        if self.public_url:
            return self.public_url.rstrip("/")
        return f"http://{self.host}:{self.server_port}" if self.host else ""

    @classmethod
    def from_dict(cls, d: dict) -> "Profile":
        known = {f.name for f in fields(cls)}
        clean = {k: v for k, v in d.items() if k in known}
        for k in ("port", "server_port"):
            if k in clean:
                try:
                    clean[k] = int(clean[k])
                except (TypeError, ValueError):
                    clean.pop(k)
        return cls(**clean)


class SecretStore:
    """keyring wrapper; `available` is False when keyring is missing or has no usable backend."""

    def __init__(self, use_keyring: bool = True):
        self._kr = None
        if use_keyring:
            try:
                import keyring  # type: ignore
                from keyring.backends import fail  # type: ignore

                backend = keyring.get_keyring()
                if not isinstance(backend, fail.Keyring) and "fail" not in type(backend).__module__:
                    self._kr = keyring
            except Exception:
                self._kr = None

    @property
    def available(self) -> bool:
        return self._kr is not None

    def get(self, pid: str, name: str) -> str:
        if not self._kr:
            return ""
        try:
            return self._kr.get_password(KEYRING_SERVICE, f"{pid}:{name}") or ""
        except Exception:
            return ""

    def set(self, pid: str, name: str, value: str) -> bool:
        if not self._kr:
            return False
        try:
            if value:
                self._kr.set_password(KEYRING_SERVICE, f"{pid}:{name}", value)
            else:
                try:
                    self._kr.delete_password(KEYRING_SERVICE, f"{pid}:{name}")
                except Exception:
                    pass
            return True
        except Exception:
            return False


class ProfileStore:
    def __init__(self, path: Optional[str] = None, secrets: Optional[SecretStore] = None):
        self.path = path or os.path.join(config_dir(), "profiles.json")
        self.secrets = secrets if secrets is not None else SecretStore()
        self.profiles: List[Profile] = []
        self.last_used: str = ""

    @property
    def secrets_in_file(self) -> bool:
        """True when secrets end up in profiles.json (no keyring): the UI shows a warning."""
        return not self.secrets.available

    def load(self) -> List[Profile]:
        self.profiles = []
        if not os.path.exists(self.path):
            return self.profiles
        with open(self.path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        file_secrets: Dict[str, Dict[str, str]] = data.get("secrets", {})
        self.last_used = data.get("lastUsed", "")
        for raw in data.get("profiles", []):
            p = Profile.from_dict(raw)
            for name in SECRET_FIELDS:
                value = self.secrets.get(p.id, name) or file_secrets.get(p.id, {}).get(name, "")
                setattr(p, name, value)
            self.profiles.append(p)
        return self.profiles

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        out_profiles, file_secrets = [], {}
        for p in self.profiles:
            d = asdict(p)
            secret_vals = {n: d.pop(n) for n in SECRET_FIELDS}
            out_profiles.append(d)
            for n, v in secret_vals.items():
                if not self.secrets.set(p.id, n, v) and v:
                    file_secrets.setdefault(p.id, {})[n] = v
        data: dict = {"version": 1, "lastUsed": self.last_used, "profiles": out_profiles}
        if file_secrets:
            data["secrets"] = file_secrets
            data["_warning"] = "Secrets are stored in plain text because the 'keyring' package is not available."
        tmp = self.path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass

    def get(self, pid: str) -> Optional[Profile]:
        return next((p for p in self.profiles if p.id == pid), None)

    def upsert(self, profile: Profile) -> None:
        for i, p in enumerate(self.profiles):
            if p.id == profile.id:
                self.profiles[i] = profile
                break
        else:
            self.profiles.append(profile)

    def remove(self, pid: str) -> None:
        self.profiles = [p for p in self.profiles if p.id != pid]
        for n in SECRET_FIELDS:
            self.secrets.set(pid, n, "")
