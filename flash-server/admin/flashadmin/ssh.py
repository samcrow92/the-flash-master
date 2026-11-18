"""SSH connection (paramiko): host key check, exec with streaming, SFTP with progress, local port forward, shells."""
from __future__ import annotations

import os
import posixpath
import select
import socket
import stat
import threading
from typing import Callable, List, Optional

import paramiko

from . import remote
from .profiles import Profile, config_dir

LineFn = Callable[[str], None]
ProgressFn = Callable[[int, int], None]


class HostKeyChanged(Exception):
    pass


class SshError(Exception):
    pass


def fingerprint(key: paramiko.PKey) -> str:
    import base64
    import hashlib

    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


class _FirstUsePolicy(paramiko.MissingHostKeyPolicy):
    """Trust-on-first-use: accept and remember an unknown key, record a warning for the UI."""

    def __init__(self, known_path: str):
        self.known_path = known_path
        self.accepted: Optional[str] = None

    def missing_host_key(self, client, hostname, key):  # noqa: D401
        client.get_host_keys().add(hostname, key.get_name(), key)
        os.makedirs(os.path.dirname(self.known_path), exist_ok=True)
        client.get_host_keys().save(self.known_path)
        try:
            os.chmod(self.known_path, 0o600)
        except OSError:
            pass
        self.accepted = f"{key.get_name()} {fingerprint(key)}"


class Tunnel:
    """127.0.0.1:<local_port> → (remote) 127.0.0.1:<remote_port> through the SSH transport."""

    def __init__(self, transport: paramiko.Transport, remote_port: int, remote_host: str = "127.0.0.1"):
        self.transport, self.remote = transport, (remote_host, remote_port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.local_port = self.sock.getsockname()[1]
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, name="flash-tunnel", daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.local_port}"

    def _serve(self) -> None:
        self.sock.settimeout(0.5)
        while not self._stop.is_set():
            try:
                client, addr = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._pipe, args=(client, addr), daemon=True).start()

    def _pipe(self, client: socket.socket, addr) -> None:
        try:
            chan = self.transport.open_channel("direct-tcpip", self.remote, addr, timeout=10)
        except Exception:
            client.close()
            return
        try:
            while not self._stop.is_set():
                r, _, _ = select.select([client, chan], [], [], 0.5)
                if client in r:
                    data = client.recv(65536)
                    if not data:
                        break
                    chan.sendall(data)
                if chan in r:
                    data = chan.recv(65536)
                    if not data:
                        break
                    client.sendall(data)
        except Exception:
            pass
        finally:
            chan.close()
            client.close()

    def close(self) -> None:
        self._stop.set()
        try:
            self.sock.close()
        except OSError:
            pass


class Shell:
    """Interactive shell channel with a pty."""

    def __init__(self, chan: paramiko.Channel):
        self.chan = chan

    def recv(self, timeout: float = 0.2) -> Optional[bytes]:
        """Bytes available (b'' none yet); None once the shell closed."""
        if self.chan.closed or self.chan.exit_status_ready() and not self.chan.recv_ready():
            return None
        r, _, _ = select.select([self.chan], [], [], timeout)
        if not r:
            return b""
        data = self.chan.recv(65536)
        return data if data else None

    def send(self, data: bytes) -> None:
        self.chan.sendall(data)

    def resize(self, cols: int, rows: int) -> None:
        try:
            self.chan.resize_pty(width=cols, height=rows)
        except Exception:
            pass

    def close(self) -> None:
        self.chan.close()


class Running:
    """Handle for a streaming command so the UI can stop it (e.g. journalctl -f)."""

    def __init__(self):
        self.chan: Optional[paramiko.Channel] = None
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True
        if self.chan is not None:
            try:
                self.chan.close()
            except Exception:
                pass


class SshSession:
    def __init__(self, profile: Profile, known_hosts: Optional[str] = None):
        self.profile = profile
        self.known_hosts = known_hosts or os.path.join(config_dir(), "known_hosts")
        self.client: Optional[paramiko.SSHClient] = None
        self.tunnel: Optional[Tunnel] = None
        self.host_key_warning: Optional[str] = None
        self._sftp: Optional[paramiko.SFTPClient] = None
        self._sftp_lock = threading.Lock()

    # ------------------------------------------------------------ connect
    def connect(self, timeout: float = 15) -> None:
        p = self.profile
        client = paramiko.SSHClient()
        try:
            client.load_system_host_keys()
        except Exception:
            pass
        os.makedirs(os.path.dirname(self.known_hosts), exist_ok=True)
        if os.path.exists(self.known_hosts):
            client.get_host_keys().load(self.known_hosts)
        policy = _FirstUsePolicy(self.known_hosts)
        client.set_missing_host_key_policy(policy)
        kwargs = dict(hostname=p.host, port=int(p.port or 22), username=p.user or None, timeout=timeout,
                      banner_timeout=timeout, auth_timeout=timeout, allow_agent=True, look_for_keys=False)
        if p.auth == "password":
            kwargs.update(password=p.password, allow_agent=False)
        else:
            if p.key_file:
                kwargs["key_filename"] = os.path.expanduser(p.key_file)
                if p.password:
                    kwargs["passphrase"] = p.password
            else:
                kwargs["look_for_keys"] = True
        try:
            client.connect(**kwargs)
        except paramiko.BadHostKeyException as e:
            raise HostKeyChanged(
                f"Host key for {p.host} CHANGED (now {fingerprint(e.key)}). Refusing to connect. "
                f"If the server was reinstalled, remove its line from {self.known_hosts}.") from None
        except paramiko.AuthenticationException as e:
            raise SshError(f"Authentication failed for {p.display_target()}: {e}") from None
        except (socket.error, paramiko.SSHException, OSError) as e:
            raise SshError(f"Cannot connect to {p.display_target()}: {e}") from None
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(30)
        self.client = client
        self.host_key_warning = (f"First connection to {p.host}: accepted host key {policy.accepted}. "
                                 "Verify it matches the server.") if policy.accepted else None

    @property
    def connected(self) -> bool:
        t = self.client.get_transport() if self.client else None
        return bool(t and t.is_active())

    def _transport(self) -> paramiko.Transport:
        t = self.client.get_transport() if self.client else None
        if not t or not t.is_active():
            raise SshError("Not connected")
        return t

    def open_tunnel(self, remote_port: int) -> Tunnel:
        if self.tunnel:
            self.tunnel.close()
        self.tunnel = Tunnel(self._transport(), remote_port)
        return self.tunnel

    def close(self) -> None:
        if self.tunnel:
            self.tunnel.close()
            self.tunnel = None
        if self._sftp:
            try:
                self._sftp.close()
            except Exception:
                pass
            self._sftp = None
        if self.client:
            self.client.close()
            self.client = None

    # --------------------------------------------------------------- exec
    def wrap_sudo(self, cmd: str, user: Optional[str] = None) -> str:
        return remote.sudo(cmd, bool(self.profile.sudo_secret()), user)

    def exec(self, cmd: str, *, sudo: bool = False, sudo_user: Optional[str] = None,
             on_line: Optional[LineFn] = None, running: Optional[Running] = None,
             timeout: Optional[float] = None) -> tuple:
        """Run cmd; stream combined stdout/stderr lines to on_line. Returns (exit_code, output)."""
        full = self.wrap_sudo(cmd, sudo_user) if sudo else cmd
        chan = self._transport().open_session()
        if running is not None:
            running.chan = chan
        chan.set_combine_stderr(True)
        if timeout:
            chan.settimeout(timeout)
        chan.exec_command(full)
        if sudo and self.profile.sudo_secret():
            chan.sendall((self.profile.sudo_secret() + "\n").encode())
        out: List[str] = []
        buf = b""
        try:
            while True:
                data = chan.recv(32768)
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    line = raw.decode("utf-8", "replace").rstrip("\r")
                    out.append(line)
                    if on_line:
                        on_line(line)
        except (socket.timeout, OSError, EOFError):
            if not (running and running.cancelled):
                raise
        if buf:
            line = buf.decode("utf-8", "replace").rstrip("\r")
            out.append(line)
            if on_line:
                on_line(line)
        code = -1 if (running and running.cancelled) else chan.recv_exit_status()
        chan.close()
        return code, "\n".join(out)

    def run(self, cmd: str, **kw) -> str:
        """exec that raises on a non-zero exit (message = last output lines)."""
        code, out = self.exec(cmd, **kw)
        if code != 0:
            tail = "\n".join(out.strip().splitlines()[-4:]) or f"exit code {code}"
            if "a password is required" in out or "incorrect password" in out:
                tail = "sudo needs a password: set it in the connection profile."
            raise SshError(tail)
        return out

    # --------------------------------------------------------------- sftp
    def sftp(self) -> paramiko.SFTPClient:
        with self._sftp_lock:
            if self._sftp is None or self._sftp.get_channel().closed:
                self._sftp = self.client.open_sftp() if self.client else None
            if self._sftp is None:
                raise SshError("Not connected")
            return self._sftp

    def listdir(self, path: str) -> List[dict]:
        out = []
        for a in self.sftp().listdir_attr(path):
            out.append({"name": a.filename, "dir": stat.S_ISDIR(a.st_mode or 0), "size": a.st_size or 0,
                        "mtime": a.st_mtime or 0, "mode": a.st_mode or 0})
        out.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        return out

    def home(self) -> str:
        return self.sftp().normalize(".")

    def mktemp_dir(self) -> str:
        return self.run("d=$(mktemp -d /tmp/flash-admin.XXXXXX) && chmod 755 \"$d\" && echo \"$d\"").strip().splitlines()[-1]

    def put(self, local: str, remote_path: str, progress: Optional[ProgressFn] = None) -> None:
        self.sftp().put(local, remote_path, callback=progress)
        try:
            self.sftp().chmod(remote_path, 0o644)
        except IOError:
            pass

    def get(self, remote_path: str, local: str, progress: Optional[ProgressFn] = None) -> None:
        self.sftp().get(remote_path, local, callback=progress)

    def put_tree(self, files: List[tuple], remote_root: str, progress: Optional[ProgressFn] = None) -> None:
        """files = [(local, posix relative)]; creates directories; progress over total bytes."""
        sftp = self.sftp()
        total = sum(os.path.getsize(f) for f, _ in files) or 1
        done = 0
        made = set()
        for local, rel in files:
            rdir = posixpath.dirname(posixpath.join(remote_root, rel))
            parts = []
            d = rdir
            while d not in made and d not in ("/", ""):
                parts.append(d)
                d = posixpath.dirname(d)
            for d in reversed(parts):
                try:
                    sftp.mkdir(d, 0o755)
                except IOError:
                    pass
                made.add(d)
            size = os.path.getsize(local)
            base = done
            sftp.put(local, posixpath.join(remote_root, rel),
                     callback=(lambda a, b, base=base: progress(base + a, total)) if progress else None)
            done += size
        if progress:
            progress(total, total)

    # ------------------------------------------------------------- shells
    def open_shell(self, cols: int = 120, rows: int = 32, term: str = "xterm-256color") -> Shell:
        chan = self._transport().open_session()
        chan.get_pty(term=term, width=cols, height=rows)
        chan.invoke_shell()
        chan.settimeout(None)
        return Shell(chan)
