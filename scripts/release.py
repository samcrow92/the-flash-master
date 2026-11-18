#!/usr/bin/env python3
"""Build the Windows binaries locally and publish them as a GitHub Release on the configured git remote.

    py -3 scripts/release.py                 interactive: suggests the next version, builds, uploads, publishes
    py -3 scripts/release.py --dry-run       checks everything and prints the plan; builds and changes nothing
    py -3 scripts/release.py --no-publish    builds and packages locally, stops before GitHub
    py -3 scripts/release.py --bump minor --yes --notes "What changed"

Steps: preflight checks -> choose version -> checks (npm run ci) -> build -> package (electron-builder)
-> latest.json + SHA256SUMS.txt -> draft release -> upload assets -> publish.

The release is created as a draft first, so the tag only appears (and users only see it) once every file is
uploaded and verified. If an upload fails, the draft stays: run the script again with --skip-build to resume.
package.json / package-lock.json carry the release version only during the build and are restored afterwards,
the same way .github/workflows/release.yml does it.

Auth: GH_TOKEN / GITHUB_TOKEN (GH_ENTERPRISE_TOKEN for Enterprise hosts), else `gh auth token`.
Works with github.com, GitHub Enterprise Server and <name>.ghe.com remotes. Standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

ROOT = Path(__file__).resolve().parent.parent
RELEASE_DIR = ROOT / "release"
PRODUCT = "TheFlashMaster"
MIN_NODE = (22, 13, 0)
MIN_PYTHON = (3, 9)
USER_AGENT = "theflashmaster-release-script"


# ───────────────────────────── errors ─────────────────────────────

class ReleaseError(Exception):
    """A failure with a message for the user and, when we know one, a hint on how to fix it."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


# ───────────────────────────── versions ─────────────────────────────

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    pre: str = ""

    @staticmethod
    def parse(text: str) -> "Version":
        m = _SEMVER.match(text.strip())
        if not m:
            raise ValueError(f"not a semantic version: {text!r} (expected e.g. 1.2.3 or 1.2.3-beta.1)")
        return Version(int(m[1]), int(m[2]), int(m[3]), m[4] or "")

    @staticmethod
    def try_parse(text: str) -> Optional["Version"]:
        try:
            return Version.parse(text)
        except ValueError:
            return None

    @property
    def core(self) -> "Version":
        return Version(self.major, self.minor, self.patch)

    def bump(self, kind: str) -> "Version":
        """npm-style increments: a pre-release bumps to its own release first (1.2.0-rc.1 + patch = 1.2.0)."""
        if kind == "patch":
            return self.core if self.pre else Version(self.major, self.minor, self.patch + 1)
        if kind == "minor":
            if self.pre and self.patch == 0:
                return self.core
            return Version(self.major, self.minor + 1, 0)
        if kind == "major":
            if self.pre and self.minor == 0 and self.patch == 0:
                return self.core
            return Version(self.major + 1, 0, 0)
        raise ValueError(f"unknown bump: {kind}")

    def _key(self) -> tuple:
        # A release sorts after its pre-releases; pre-release identifiers compare numerically when numeric.
        pre: tuple = (1,) if not self.pre else (0, *[(0, int(p), "") if p.isdigit() else (1, 0, p) for p in self.pre.split(".")])
        return (self.major, self.minor, self.patch, pre)

    def __lt__(self, other: "Version") -> bool:
        return self._key() < other._key()

    def __le__(self, other: "Version") -> bool:
        return self._key() <= other._key()

    def __gt__(self, other: "Version") -> bool:
        return self._key() > other._key()

    def __ge__(self, other: "Version") -> bool:
        return self._key() >= other._key()

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}" + (f"-{self.pre}" if self.pre else "")

    @property
    def tag(self) -> str:
        return f"v{self}"


@dataclass
class BaseVersion:
    version: Version
    source: str  # human-readable: where the current version came from


def pick_base_version(releases: Iterable[dict], package_version: Optional[str]) -> BaseVersion:
    """The current version: the newest release on GitHub (drafts and pre-releases count, they are the release
    history too). package.json is the fallback when the repository has no release yet."""
    best: Optional[BaseVersion] = None
    for r in releases:
        v = Version.try_parse(str(r.get("tag_name", "")))
        if not v:
            continue
        kind = "draft " if r.get("draft") else ""
        kind += "pre-release" if r.get("prerelease") else "release"
        if best is None or v > best.version:
            best = BaseVersion(v, f"latest {kind} on GitHub ({r['tag_name']})")
    if best:
        return best
    pv = Version.try_parse(package_version or "")
    if pv:
        return BaseVersion(pv, "package.json (no GitHub release yet)")
    return BaseVersion(Version(0, 0, 0), "nothing found (no releases, no package.json version)")


def suggestions(base: Version, package_version: Optional[str] = None) -> list[tuple[str, Version]]:
    """patch / minor / major from the current version, plus package.json's version when someone already bumped it."""
    opts: list[tuple[str, Version]] = []
    for kind in ("patch", "minor", "major"):
        v = base.bump(kind)
        if all(v != o for _, o in opts):  # from a pre-release, patch and minor can both mean "release it"
            opts.append((kind, v))
    pv = Version.try_parse(package_version or "")
    if pv and pv > base and all(pv != v for _, v in opts):
        opts.append(("from package.json", pv))
    return opts


# ───────────────────────────── remotes & GitHub hosts ─────────────────────────────

@dataclass(frozen=True)
class Remote:
    host: str
    owner: str
    repo: str

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def api_base(self) -> str:
        if self.host == "github.com":
            return "https://api.github.com"
        if self.host.endswith(".ghe.com"):  # GitHub Enterprise Cloud with data residency
            return f"https://api.{self.host}"
        return f"https://{self.host}/api/v3"  # GitHub Enterprise Server

    @property
    def web_url(self) -> str:
        return f"https://{self.host}/{self.slug}"


def parse_remote_url(url: str) -> Remote:
    """https://host/owner/repo(.git), git@host:owner/repo.git, ssh://git@host[:port]/owner/repo.git"""
    url = url.strip()
    m = re.match(r"^[\w.-]+@([^:/]+):(?P<path>.+)$", url)  # scp-like ssh
    if m:
        host, path = m[1], m["path"]
    else:
        p = urllib.parse.urlparse(url)
        if not p.hostname or p.scheme not in ("https", "http", "ssh", "git"):
            raise ValueError(f"unsupported remote URL: {url}")
        host, path = p.hostname, p.path
    parts = [s for s in path.strip("/").split("/") if s]
    if len(parts) < 2:
        raise ValueError(f"remote URL has no owner/repo: {url}")
    owner, repo = parts[-2], parts[-1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    host = host.lower()
    if host.startswith("ssh."):  # ssh.github.com:443
        host = host[4:]
    return Remote(host, owner, repo)


# ───────────────────────────── artifacts ─────────────────────────────

def expected_asset_names(version: Version) -> list[str]:
    return [
        f"{PRODUCT}-{version}-x64-setup.exe",
        f"{PRODUCT}-{version}-x64-portable.exe",
        "latest.json",
        "SHA256SUMS.txt",
    ]


def collect_assets(release_dir: Path, version: Version) -> list[Path]:
    """Everything the release needs from release/: both executables, latest.json, SHA256SUMS.txt, plus the
    electron-builder update metadata (.blockmap, latest.yml) when the build produced it."""
    if not release_dir.is_dir():
        raise ReleaseError(f"{release_dir} does not exist", "Build first (run without --skip-build).")
    v = str(version)
    found: list[Path] = []
    for f in sorted(release_dir.iterdir(), key=lambda p: p.name):  # by name: WindowsPath sorts case-insensitively
        if not f.is_file():
            continue
        n = f.name
        if n in ("latest.json", "SHA256SUMS.txt"):
            found.append(f)
        elif v in n and (n.endswith(".exe") or n.endswith(".exe.blockmap")) and n.startswith(PRODUCT):
            found.append(f)
        elif n == "latest.yml" and f"version: {v}" in f.read_text("utf-8", errors="replace"):
            found.append(f)
    names = {f.name for f in found}
    missing = [n for n in expected_asset_names(version) if n not in names]
    if missing:
        raise ReleaseError(
            f"missing release files in {release_dir.name}/: {', '.join(missing)}",
            "Run the build again (without --skip-build); check the build log for electron-builder errors.",
        )
    manifest = json.loads((release_dir / "latest.json").read_text("utf-8"))
    if manifest.get("version") != v:
        raise ReleaseError(
            f"release/latest.json is for {manifest.get('version')}, not {v}",
            "It is left over from another build. Run without --skip-build to rebuild.",
        )
    return found


def sha256_file(path: Path, on_progress: Optional[Callable[[int], None]] = None) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            if on_progress:
                on_progress(len(chunk))
    return h.hexdigest()


def format_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def format_duration(seconds: float) -> str:
    s = int(max(0, seconds))
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


# ───────────────────────────── terminal UI ─────────────────────────────

class UI:
    def __init__(self, color: bool) -> None:
        self.tty = sys.stdout.isatty()
        self.color = color and self.tty and _enable_ansi()
        enc = (getattr(sys.stdout, "encoding", "") or "").lower()
        self.unicode = "utf" in enc
        self.ok = "✔" if self.unicode else "OK"
        self.bad = "✖" if self.unicode else "X"
        self.warn_mark = "⚠" if self.unicode else "!"
        self.info_mark = "ℹ" if self.unicode else "i"
        self.spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏" if self.unicode else "|/-\\"
        self.full, self.empty = ("█", "░") if self.unicode else ("#", "-")
        self.step_no = 0
        self.step_total = 0

    def _c(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def bold(self, t: str) -> str: return self._c("1", t)
    def dim(self, t: str) -> str: return self._c("2", t)
    def green(self, t: str) -> str: return self._c("32", t)
    def red(self, t: str) -> str: return self._c("31", t)
    def yellow(self, t: str) -> str: return self._c("33", t)
    def cyan(self, t: str) -> str: return self._c("36", t)

    def width(self) -> int:
        return max(40, min(shutil.get_terminal_size((100, 20)).columns, 120))

    def banner(self, text: str) -> None:
        print(self.bold(self.cyan(text)))

    def step(self, title: str) -> None:
        self.step_no += 1
        print(f"\n{self.bold(self.cyan(f'[{self.step_no}/{self.step_total}]'))} {self.bold(title)}")

    def success(self, t: str) -> None: print(f"  {self.green(self.ok)} {t}")
    def fail(self, t: str) -> None: print(f"  {self.red(self.bad)} {t}")
    def warn(self, t: str) -> None: print(f"  {self.yellow(self.warn_mark)} {t}")
    def info(self, t: str) -> None: print(f"  {self.dim(self.info_mark)} {t}")

    def clear_line(self) -> None:
        if self.tty:
            sys.stdout.write("\r" + " " * (self.width() - 1) + "\r")

    def ask(self, question: str, default: str = "") -> str:
        suffix = f" [{default}]" if default else ""
        try:
            answer = input(f"  {self.bold('?')} {question}{suffix}: ").strip()
        except EOFError:
            answer = ""
        return answer or default

    def confirm(self, question: str, default: bool = False) -> bool:
        while True:
            a = self.ask(question + (" (Y/n)" if default else " (y/N)")).lower()
            if not a:
                return default
            if a in ("y", "yes"):
                return True
            if a in ("n", "no"):
                return False


def _enable_ansi() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if os.name != "nt":
        return True
    try:  # Windows 10+: turn on virtual-terminal processing for this console
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


class ProgressBar:
    """label [██████░░░░]  62%  41.2/66.5 MB  5.1 MB/s  ETA 00:05 — redraws in place; plain milestones when piped."""

    def __init__(self, ui: UI, total: int, label: str) -> None:
        self.ui, self.total, self.label = ui, max(total, 1), label
        self.done = 0
        self.started = time.monotonic()
        self.last_draw = 0.0
        self.last_milestone = 0

    def update(self, n: int) -> None:
        self.done = min(self.total, self.done + n)
        now = time.monotonic()
        if self.ui.tty:
            if now - self.last_draw >= 0.1 or self.done >= self.total:
                self.last_draw = now
                self._draw(now)
        else:
            milestone = int(self.done * 4 / self.total)
            if milestone > self.last_milestone:
                self.last_milestone = milestone
                print(f"    {self.label}: {milestone * 25}%")

    def reset(self) -> None:
        self.done = 0
        self.started = time.monotonic()

    def _draw(self, now: float) -> None:
        frac = self.done / self.total
        elapsed = max(now - self.started, 1e-6)
        rate = self.done / elapsed
        eta = (self.total - self.done) / rate if rate > 0 else 0
        stats = f" {frac * 100:3.0f}%  {format_bytes(self.done)}/{format_bytes(self.total)}  {format_bytes(rate)}/s  ETA {format_duration(eta)}"
        label = self.label[:28]
        bar_w = max(10, self.ui.width() - len(label) - len(stats) - 8)
        filled = int(bar_w * frac)
        bar = self.ui.green(self.ui.full * filled) + self.ui.dim(self.ui.empty * (bar_w - filled))
        sys.stdout.write(f"\r    {label} {bar}{stats}")
        sys.stdout.flush()

    def finish(self, note: str = "") -> None:
        if self.ui.tty:
            self.ui.clear_line()
        took = format_duration(time.monotonic() - self.started)
        self.ui.success(f"{self.label} {self.ui.dim(f'({format_bytes(self.total)}, {took}{note})')}")


# ───────────────────────────── running commands ─────────────────────────────

def which(cmd: str) -> Optional[str]:
    return shutil.which(cmd)


def capture(args: list[str], cwd: Path = ROOT, check: bool = True, strip: bool = True) -> str:
    exe = which(args[0]) or args[0]
    try:
        r = subprocess.run([exe, *args[1:]], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise ReleaseError(f"`{args[0]}` was not found on PATH")
    if check and r.returncode != 0:
        raise ReleaseError(f"`{' '.join(args)}` failed (exit {r.returncode}): {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout.strip() if strip else r.stdout


class Runner:
    """Runs a build command with a live spinner, elapsed time and its latest output line; full output goes to the log."""

    def __init__(self, ui: UI, log_path: Path) -> None:
        self.ui = ui
        self.log_path = log_path

    def run(self, title: str, args: list[str], hint: str = "", env: Optional[dict] = None) -> None:
        exe = which(args[0])
        if not exe:
            raise ReleaseError(f"`{args[0]}` was not found on PATH", hint)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        tail: deque[str] = deque(maxlen=40)
        last = [""]
        started = time.monotonic()
        if not self.ui.tty:
            print(f"    ... {title}", flush=True)
        with self.log_path.open("a", encoding="utf-8") as log:
            log.write(f"\n===== {title}: {' '.join(args)} ({time.strftime('%Y-%m-%d %H:%M:%S')}) =====\n")
            log.flush()
            proc = subprocess.Popen(
                [exe, *args[1:]], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env={**os.environ, "FORCE_COLOR": "0", **(env or {})},
            )

            def pump() -> None:
                assert proc.stdout is not None
                for raw in iter(proc.stdout.readline, b""):
                    line = raw.decode("utf-8", errors="replace").rstrip()
                    log.write(line + "\n")
                    clean = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line).strip()
                    if clean:
                        tail.append(clean)
                        last[0] = clean

            reader = threading.Thread(target=pump, daemon=True)
            reader.start()
            i = 0
            try:
                while proc.poll() is None:
                    if self.ui.tty:
                        el = format_duration(time.monotonic() - started)
                        prefix = f"\r    {self.ui.cyan(self.ui.spin[i % len(self.ui.spin)])} {title} {self.ui.dim(el)}  "
                        room = self.ui.width() - len(title) - len(el) - 12
                        sys.stdout.write(prefix + self.ui.dim(last[0][:max(0, room)].ljust(max(0, room))))
                        sys.stdout.flush()
                    i += 1
                    time.sleep(0.12)
            except KeyboardInterrupt:
                proc.terminate()
                raise
            reader.join(timeout=5)
        self.ui.clear_line()
        took = format_duration(time.monotonic() - started)
        if proc.returncode != 0:
            self.ui.fail(f"{title} failed after {took} (exit {proc.returncode}). Last output:")
            for line in list(tail)[-15:]:
                print(f"      {self.ui.dim(line)}")
            raise ReleaseError(f"{title} failed", (hint + "\n" if hint else "") + f"Full output: {self.log_path}")
        self.ui.success(f"{title} {self.ui.dim(f'({took})')}")


# ───────────────────────────── GitHub API ─────────────────────────────

class GitHub:
    def __init__(self, remote: Remote, token: str) -> None:
        self.remote = remote
        self.token = token
        self.ctx = ssl.create_default_context()  # on Windows this includes the system (corporate) root store
        extra = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
        if extra and Path(extra).is_file():
            self.ctx.load_verify_locations(extra)

    def _headers(self, extra: Optional[dict] = None) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
            **(extra or {}),
        }

    def request(self, method: str, path: str, body: Any = None, data: Any = None, headers: Optional[dict] = None,
                timeout: float = 60, ok404: bool = False) -> Any:
        url = path if path.startswith("http") else f"{self.remote.api_base}{path}"
        payload = json.dumps(body).encode() if body is not None else data
        hdrs = self._headers(headers)
        if body is not None:
            hdrs["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=payload, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 404 and ok404:
                return None
            raise self._http_error(method, url, e) from None
        except urllib.error.URLError as e:
            raise network_error(self.remote.host, e) from None

    def _http_error(self, method: str, url: str, e: urllib.error.HTTPError) -> ReleaseError:
        try:
            detail = json.loads(e.read() or b"{}")
        except Exception:
            detail = {}
        msg = detail.get("message", e.reason)
        errors = "; ".join(str(x.get("message") or x.get("code") or x) for x in detail.get("errors", []) if isinstance(x, dict))
        what = f"GitHub API {method} {urllib.parse.urlparse(url).path} -> {e.code}: {msg}" + (f" ({errors})" if errors else "")
        if e.code == 401:
            return ReleaseError(what, f"The token was rejected. Run `gh auth login --hostname {self.remote.host}` or set a valid GH_TOKEN.")
        if e.code == 403:
            if e.headers.get("x-ratelimit-remaining") == "0":
                return ReleaseError(what, "API rate limit reached; wait a few minutes and run again.")
            if e.headers.get("x-github-sso"):
                return ReleaseError(what, "Your organization uses SSO: authorize this token for it in your GitHub token settings.")
            return ReleaseError(what, "The token lacks permission: it needs `repo` scope (classic) or Contents: read & write (fine-grained).")
        if e.code == 404:
            return ReleaseError(what, f"Check that {self.remote.slug} exists on {self.remote.host} and that the token can see it.")
        if e.code == 422:
            return ReleaseError(what, "GitHub refused the request; the tag or an asset with this name may already exist.")
        return ReleaseError(what, "GitHub may be having trouble; try again in a few minutes.")

    # convenience
    def repo(self) -> dict:
        return self.request("GET", f"/repos/{self.remote.slug}")

    def releases(self, limit: int = 100) -> list[dict]:
        return self.request("GET", f"/repos/{self.remote.slug}/releases?per_page={limit}") or []

    def upload(self, release: dict, path: Path, ui: UI, attempts: int = 3) -> dict:
        base = re.sub(r"\{.*\}$", "", release["upload_url"])
        url = f"{base}?name={urllib.parse.quote(path.name)}"
        size = path.stat().st_size
        bar = ProgressBar(ui, size, path.name)
        ctype = {".json": "application/json", ".txt": "text/plain", ".yml": "text/yaml"}.get(path.suffix, "application/octet-stream")
        for attempt in range(1, attempts + 1):
            self.delete_asset_named(release, path.name)  # clobber: an earlier run or a failed attempt may have left one
            bar.reset()
            try:
                with path.open("rb") as fh:
                    body = _ProgressReader(fh, bar.update)
                    req = urllib.request.Request(url, data=body, method="POST", headers=self._headers({
                        "Content-Type": ctype, "Content-Length": str(size)}))
                    with urllib.request.urlopen(req, context=self.ctx, timeout=600) as resp:
                        asset = json.loads(resp.read())
                bar.finish()
                return asset
            except urllib.error.HTTPError as e:
                err = self._http_error("POST", url, e)
                if e.code < 500 or attempt == attempts:
                    ui.clear_line()
                    raise err from None
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                if attempt == attempts:
                    ui.clear_line()
                    raise network_error(self.remote.host, e) from None
            ui.clear_line()
            ui.warn(f"upload of {path.name} failed (attempt {attempt}/{attempts}); retrying in {attempt * 5}s")
            time.sleep(attempt * 5)
        raise ReleaseError(f"upload of {path.name} failed")  # unreachable

    def delete_asset_named(self, release: dict, name: str) -> None:
        assets = self.request("GET", f"/repos/{self.remote.slug}/releases/{release['id']}/assets?per_page=100") or []
        for a in assets:
            if a.get("name") == name:
                self.request("DELETE", f"/repos/{self.remote.slug}/releases/assets/{a['id']}")


class _ProgressReader:
    def __init__(self, fh: Any, cb: Callable[[int], None]) -> None:
        self.fh, self.cb = fh, cb

    def read(self, n: int = -1) -> bytes:
        chunk = self.fh.read(n if n and n > 0 else 1 << 16)
        if chunk:
            self.cb(len(chunk))
        return chunk


def network_error(host: str, e: BaseException) -> ReleaseError:
    reason = getattr(e, "reason", e)
    if isinstance(reason, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
        return ReleaseError(
            f"TLS certificate check failed talking to {host}: {reason}",
            "A company proxy may re-sign HTTPS traffic. Point SSL_CERT_FILE at your company root CA bundle (.pem).",
        )
    return ReleaseError(
        f"could not reach {host}: {reason}",
        "Check your network or VPN. Behind a proxy, set HTTPS_PROXY (e.g. http://proxy.company.com:8080).",
    )


def resolve_token(host: str) -> tuple[str, str]:
    """(token, where it came from). Env vars first, then the GitHub CLI's stored login."""
    names = ["GH_TOKEN", "GITHUB_TOKEN"] if host == "github.com" else ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
    for n in names:
        if os.environ.get(n, "").strip():
            return os.environ[n].strip(), f"${n}"
    gh = which("gh")
    if gh:
        r = subprocess.run([gh, "auth", "token", "--hostname", host], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip(), f"GitHub CLI login ({host})"
    raise ReleaseError(
        f"no GitHub credentials for {host}",
        f"Run `gh auth login --hostname {host}` (https://cli.github.com), or set GH_TOKEN to a token with "
        "Contents: read & write on the repository.",
    )


# ───────────────────────────── the release flow ─────────────────────────────

@dataclass
class Plan:
    remote_name: str = "origin"
    remote: Optional[Remote] = None
    head_sha: str = ""
    branch: str = ""
    base: Optional[BaseVersion] = None
    version: Optional[Version] = None
    prerelease: bool = False
    notes: str = ""
    existing_draft: Optional[dict] = None
    cleanups: list[Callable[[], None]] = field(default_factory=list)


class Release:
    def __init__(self, args: argparse.Namespace, ui: UI) -> None:
        self.args = args
        self.ui = ui
        self.plan = Plan(remote_name=args.remote)
        self.gh: Optional[GitHub] = None
        self.log_path = RELEASE_DIR / "release-script.log"

    # 1 ── preflight
    def preflight(self) -> None:
        ui, a = self.ui, self.args
        ui.step("Preflight checks")
        problems: list[ReleaseError] = []

        def check(label: str, fn: Callable[[], Optional[str]]) -> Any:
            try:
                detail = fn()
                ui.success(label + (f" {ui.dim(detail)}" if detail else ""))
                return True
            except ReleaseError as e:
                ui.fail(f"{label}: {e.message}")
                problems.append(e)
                return False

        def py() -> str:
            if sys.version_info < MIN_PYTHON:
                raise ReleaseError(f"Python {'.'.join(map(str, MIN_PYTHON))}+ required", "Install a current Python from python.org.")
            return f"({sys.version.split()[0]})"

        def platform() -> str:
            if os.name == "nt":
                return "(Windows)"
            if a.dry_run or a.allow_non_windows:
                ui.warn("not on Windows: fine for --dry-run, but the installer build needs a Windows machine")
                return f"({sys.platform}, allowed)"
            raise ReleaseError(f"this is {sys.platform}; the Windows installer (NSIS) is built on Windows",
                               "Run the script on Windows, or use --dry-run to check the setup here.")

        def repo_root() -> str:
            if not (ROOT / "package.json").is_file() or not (ROOT / "electron-builder.yml").is_file():
                raise ReleaseError(f"{ROOT} does not look like the TheFlashMaster repository")
            return f"({ROOT})"

        def tool(name: str, install: str) -> Callable[[], str]:
            def fn() -> str:
                if not which(name):
                    raise ReleaseError(f"`{name}` not found on PATH", install)
                return ""
            return fn

        def node() -> str:
            out = capture(["node", "--version"])
            v = Version.try_parse(out)
            if not v or (v.major, v.minor, v.patch) < MIN_NODE:
                raise ReleaseError(f"Node {out} is too old; {'.'.join(map(str, MIN_NODE))}+ required", "Install Node.js 22 LTS from nodejs.org.")
            return f"({out})"

        def deps() -> str:
            if not (ROOT / "node_modules" / ".bin").is_dir():
                if a.install:
                    Runner(ui, self.log_path).run("npm ci", ["npm", "ci"], "Check your network/proxy and npm registry settings.")
                    return "(installed)"
                raise ReleaseError("node_modules is missing", "Run `npm ci` first, or pass --install.")
            if not (ROOT / "node_modules" / "electron-builder").is_dir():
                raise ReleaseError("electron-builder is not installed", "Run `npm ci`.")
            return ""

        def clean_tree() -> str:
            out = capture(["git", "status", "--porcelain"], strip=False).rstrip()
            if out:
                files = ", ".join(line[3:] for line in out.splitlines()[:5])
                if a.allow_dirty:
                    ui.warn(f"uncommitted changes are NOT in the release tag but WILL be in the binaries: {files}")
                    return "(dirty, allowed)"
                raise ReleaseError(f"uncommitted changes: {files}",
                                   "Commit or stash them (the binaries must match the tagged commit), or pass --allow-dirty.")
            return ""

        def remote() -> str:
            try:
                url = capture(["git", "remote", "get-url", self.plan.remote_name])
            except ReleaseError:
                raise ReleaseError(f"git remote `{self.plan.remote_name}` is not configured", "Pick another with --remote, see `git remote -v`.")
            try:
                self.plan.remote = parse_remote_url(url)
            except ValueError as e:
                raise ReleaseError(str(e))
            return f"({self.plan.remote_name} -> {self.plan.remote.web_url})"

        def pushed() -> str:
            self.plan.head_sha = capture(["git", "rev-parse", "HEAD"])
            self.plan.branch = capture(["git", "rev-parse", "--abbrev-ref", "HEAD"], check=False)
            try:
                capture(["git", "fetch", "--quiet", "--tags", self.plan.remote_name])
            except ReleaseError as e:
                raise ReleaseError(f"git fetch {self.plan.remote_name} failed: {e.message}", "Check your network and git credentials.")
            contains = capture(["git", "branch", "-r", "--contains", "HEAD"], check=False)
            if not any(line.strip().startswith(self.plan.remote_name + "/") for line in contains.splitlines()):
                raise ReleaseError(f"commit {self.plan.head_sha[:8]} is not on {self.plan.remote_name}",
                                   f"Push it first (`git push {self.plan.remote_name} {self.plan.branch}`): the tag is created on GitHub.")
            return f"({self.plan.branch} @ {self.plan.head_sha[:8]})"

        def auth() -> str:
            assert self.plan.remote
            token, source = resolve_token(self.plan.remote.host)
            self.gh = GitHub(self.plan.remote, token)
            info = self.gh.repo()
            perms = info.get("permissions") or {}
            if not (perms.get("push") or perms.get("admin") or perms.get("maintain")):
                raise ReleaseError(f"the token from {source} cannot write to {self.plan.remote.slug}",
                                   "Creating releases needs write access (Contents: read & write).")
            default = info.get("default_branch")
            if default and self.plan.branch and self.plan.branch != default:
                ui.warn(f"releasing from `{self.plan.branch}`, not the default branch `{default}`")
            return f"(via {source})"

        check("Python", py)
        check("Platform", platform)
        check("Repository", repo_root)
        check("git", tool("git", "Install Git for Windows: https://git-scm.com/download/win"))
        if check("Node.js", node):
            check("npm / npx", lambda: (tool("npm", "Reinstall Node.js.")(), tool("npx", "Reinstall Node.js.")())[0])
            if not a.skip_build:
                check("Dependencies", deps)
        if not a.skip_checks and not a.dry_run and not which("py") and not which("python"):
            ui.warn("Python tests in `npm run ci` look for `py -3` / `python` with pytest; pass --skip-checks if missing")
        check("Working tree", clean_tree)
        if check("Remote", remote):
            if check("Commit pushed", pushed):
                check("GitHub access", auth)
        if not os.environ.get("CSC_LINK"):
            ui.info("CSC_LINK not set: the executables will be unsigned (Windows SmartScreen may warn users)")
        if problems:
            hints = [p.hint for p in problems if p.hint]
            raise ReleaseError(f"{len(problems)} preflight check(s) failed", "\n".join(hints))

    # 2 ── version
    def choose_version(self) -> None:
        ui, a, gh = self.ui, self.args, self.gh
        assert gh and self.plan.remote
        ui.step("Choose the release version")
        releases = gh.releases()
        pkg = json.loads((ROOT / "package.json").read_text("utf-8")).get("version")
        base = pick_base_version(releases, pkg)
        self.plan.base = base
        ui.info(f"Current version: {ui.bold(str(base.version))} {ui.dim('from ' + base.source)}")
        opts = suggestions(base.version, pkg)

        if a.version:
            try:
                version = Version.parse(a.version)
            except ValueError as e:
                raise ReleaseError(str(e))
        elif a.bump:
            version = base.version.bump(a.bump)
        elif not sys.stdin.isatty() or a.yes:
            version = opts[0][1]
            ui.info(f"non-interactive: using the patch bump {version}")
        else:
            for i, (kind, v) in enumerate(opts, 1):
                print(f"    {ui.bold(str(i))}) {str(v):<14} {kind}{ui.dim('  (suggested)') if i == 1 else ''}")
            custom = str(len(opts) + 1)
            print(f"    {ui.bold(custom)}) custom")
            while True:
                choice = ui.ask("Next version (number, or type a version)", "1")
                if choice.isdigit() and 1 <= int(choice) <= len(opts):
                    version = opts[int(choice) - 1][1]
                    break
                if choice == custom or Version.try_parse(choice):
                    text = choice if choice != custom else ui.ask("Version (e.g. 1.4.0 or 1.4.0-beta.1)")
                    v = Version.try_parse(text)
                    if v:
                        version = v
                        break
                    ui.fail(f"{text!r} is not a version like 1.4.0")
                else:
                    ui.fail(f"pick 1-{custom}, or type a version")

        if version <= base.version:
            msg = f"{version} is not newer than the current {base.version}"
            if a.yes or not sys.stdin.isatty() or not ui.confirm(f"{msg}. Release it anyway?"):
                raise ReleaseError(msg, "Pick a higher version (--bump / --version).")

        # The tag must be free on the remote, and no published release may use it. A draft for it can be resumed.
        tag = version.tag
        if capture(["git", "ls-remote", "--tags", self.plan.remote_name, f"refs/tags/{tag}"], check=False):
            raise ReleaseError(f"tag {tag} already exists on {self.plan.remote_name}", "Choose another version.")
        same = [r for r in releases if r.get("tag_name") == tag]
        for r in same:
            if not r.get("draft"):
                raise ReleaseError(f"release {tag} is already published: {r.get('html_url')}", "Choose another version.")
        if same:
            draft = same[0]
            ui.warn(f"a draft release for {tag} already exists ({draft.get('html_url')})")
            if a.yes or a.skip_build or not sys.stdin.isatty() or ui.confirm("Reuse it (re-uploads every file)?", default=True):
                self.plan.existing_draft = draft
            else:
                raise ReleaseError(f"draft release {tag} exists", "Delete it on GitHub or choose another version.")

        self.plan.version = version
        self.plan.prerelease = bool(a.prerelease or version.pre)
        if a.notes_file:
            self.plan.notes = Path(a.notes_file).read_text("utf-8").strip()
        elif a.notes:
            self.plan.notes = a.notes.strip()
        ui.success(f"Releasing {ui.bold(tag)}" + (" as a pre-release" if self.plan.prerelease else "")
                   + f" from {self.plan.branch} @ {self.plan.head_sha[:8]}")

    # 3 ── build
    def build(self) -> None:
        ui, a, v = self.ui, self.args, self.plan.version
        assert v
        ui.step("Build the Windows binaries")
        RELEASE_DIR.mkdir(exist_ok=True)
        self.log_path.write_text(f"TheFlashMaster release {v} - {time.ctime()}\n", "utf-8")
        ui.info(f"build log: {self.log_path}")

        # Same as release.yml: stamp the version for the build only, restore the files afterwards.
        saved = {p: p.read_bytes() for p in (ROOT / "package.json", ROOT / "package-lock.json") if p.is_file()}

        def restore() -> None:
            for p, data in saved.items():
                if p.read_bytes() != data:
                    p.write_bytes(data)

        self.plan.cleanups.append(restore)
        run = Runner(ui, self.log_path).run
        run(f"Set version {v}", ["npm", "version", str(v), "--no-git-tag-version", "--allow-same-version"])
        run("Check Electron download", ["node", "scripts/ensure-electron.mjs"], "Run `npm ci` again; a proxy may block the Electron download.")
        if a.skip_checks:
            ui.warn("skipping checks (--skip-checks)")
        else:
            run("Checks (typecheck, lint, tests, build)", ["node", "scripts/ci.mjs"],
                "Fix the failing check, or pass --skip-checks if you already ran `npm run ci` on this commit.")
        if a.skip_checks:
            run("Build (electron-vite)", ["npx", "electron-vite", "build"])
        # ci.mjs already ran `electron-vite build` with the stamped version.
        for stale in RELEASE_DIR.glob(f"{PRODUCT}-{v}-*"):
            stale.unlink()  # never upload a leftover from an earlier attempt at this version
        run("Package installer + portable exe (electron-builder)", ["npx", "electron-builder", "--win", "--x64", "--publish", "never"],
            "Close any running TheFlashMaster.exe from release/; check signing settings (CSC_LINK) if signing failed.")
        manifest_args = ["node", "scripts/release-manifest.mjs"] + (["--notes", self.plan.notes] if self.plan.notes else [])
        run("Update manifest (latest.json)", manifest_args)
        restore()
        ui.success("package.json restored")

    # 4 ── checksums
    def checksums(self) -> list[Path]:
        ui, v = self.ui, self.plan.version
        assert v
        ui.step("Checksums")
        exes = sorted(RELEASE_DIR.glob(f"{PRODUCT}-{v}-*.exe"))
        if not exes:
            raise ReleaseError(f"no {v} executables in release/", "Build first (run without --skip-build).")
        lines = []
        for exe in exes:
            bar = ProgressBar(ui, exe.stat().st_size, f"SHA-256 {exe.name}")
            digest = sha256_file(exe, bar.update)
            bar.finish()
            lines.append(f"{digest}  {exe.name}")
        (RELEASE_DIR / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", "ascii")
        assets = collect_assets(RELEASE_DIR, v)
        for f in assets:
            ui.info(f"{f.name:<52} {format_bytes(f.stat().st_size):>10}")
        return assets

    # 5 ── publish
    def publish(self, assets: list[Path]) -> str:
        ui, a, gh, v = self.ui, self.args, self.gh, self.plan.version
        assert gh and v and self.plan.remote
        ui.step("Publish on GitHub")
        total = sum(f.stat().st_size for f in assets)
        kind = "draft" if a.draft else ("pre-release" if self.plan.prerelease else "release")
        print(f"    {ui.bold(v.tag)} -> {self.plan.remote.web_url}/releases  ({kind}, {len(assets)} files, {format_bytes(total)})")
        if not a.yes and not ui.confirm("Publish now?"):
            raise ReleaseError("cancelled before publishing", f"Nothing was created on GitHub. The build is in {RELEASE_DIR}.")

        slug = self.plan.remote.slug
        rel = self.plan.existing_draft
        if rel:
            rel = gh.request("PATCH", f"/repos/{slug}/releases/{rel['id']}", {
                "target_commitish": self.plan.head_sha, "prerelease": self.plan.prerelease,
                **({"body": self.plan.notes} if self.plan.notes else {})})
            ui.success(f"Reusing draft {rel['html_url']}")
        else:
            rel = gh.request("POST", f"/repos/{slug}/releases", {
                "tag_name": v.tag, "target_commitish": self.plan.head_sha, "name": f"{PRODUCT} {v}",
                "body": self.plan.notes, "draft": True, "prerelease": self.plan.prerelease,
                "generate_release_notes": not self.plan.notes,
            })
            ui.success(f"Draft release created {ui.dim(rel['html_url'])}")

        # Executables first, manifests last: latest.json only points at files that are already there.
        for f in sorted(assets, key=lambda p: (p.suffix not in (".exe", ".blockmap"), p.name)):
            gh.upload(rel, f, ui)

        uploaded = {x["name"]: x for x in gh.request("GET", f"/repos/{slug}/releases/{rel['id']}/assets?per_page=100") or []}
        bad = [f.name for f in assets if f.name not in uploaded or uploaded[f.name].get("size") != f.stat().st_size
               or uploaded[f.name].get("state") != "uploaded"]
        if bad:
            raise ReleaseError(f"verification failed for: {', '.join(bad)}", f"The draft is kept; run again with --skip-build --version {v} to re-upload.")
        ui.success(f"All {len(assets)} files verified on GitHub")

        if a.draft:
            ui.info("left as a draft (--draft): publish it from the GitHub releases page")
            return rel["html_url"]
        rel = gh.request("PATCH", f"/repos/{slug}/releases/{rel['id']}", {
            "draft": False, "prerelease": self.plan.prerelease, "make_latest": "false" if self.plan.prerelease else "true"})
        ui.success(f"Published {ui.bold(v.tag)}")
        return rel["html_url"]

    # dry run
    def show_plan(self) -> None:
        ui, v, a = self.ui, self.plan.version, self.args
        assert v and self.plan.remote
        ui.step("Plan (dry run, nothing changed)")
        steps = [f"npm version {v} --no-git-tag-version   (restored afterwards)"]
        if not a.skip_checks:
            steps.append("node scripts/ci.mjs                      (typecheck, lint, tests, build)")
        else:
            steps.append("npx electron-vite build")
        steps += ["npx electron-builder --win --x64 --publish never",
                  "node scripts/release-manifest.mjs + SHA256SUMS.txt",
                  ("reuse draft " if self.plan.existing_draft else "create draft ") + f"{v.tag} on {self.plan.remote.slug} at {self.plan.head_sha[:8]}",
                  "upload: " + ", ".join(expected_asset_names(v)) + " (+ .blockmap / latest.yml if built)",
                  "leave as draft" if a.draft else f"publish {v.tag}" + (" as pre-release" if self.plan.prerelease else "")]
        for i, s in enumerate(steps if not a.skip_build else steps[4:], 1):
            print(f"    {i}. {s}")

    def run(self) -> int:
        a, ui = self.args, self.ui
        ui.step_total = 2 + (1 if a.dry_run else (0 if a.skip_build else 1) + 1 + (0 if a.no_publish else 1))
        started = time.monotonic()
        try:
            self.preflight()
            self.choose_version()
            if a.dry_run:
                self.show_plan()
                print(f"\n{ui.green(ui.ok)} Dry run finished: run without --dry-run to release {ui.bold(self.plan.version.tag)}.")  # type: ignore[union-attr]
                return 0
            if not a.skip_build:
                self.build()
            assets = self.checksums()
            if a.no_publish:
                print(f"\n{ui.green(ui.ok)} Built {self.plan.version} in {format_duration(time.monotonic() - started)}; "
                      f"not published (--no-publish). Files: {RELEASE_DIR}")
                return 0
            url = self.publish(assets)
            print(f"\n{ui.green(ui.ok)} {ui.bold(f'Released {self.plan.version.tag}')} in {format_duration(time.monotonic() - started)}")  # type: ignore[union-attr]
            print(f"    {url}")
            return 0
        finally:
            for fn in reversed(self.plan.cleanups):
                try:
                    fn()
                except Exception as e:  # never hide the original error behind a cleanup failure
                    ui.warn(f"cleanup step failed: {e}")


# ───────────────────────────── CLI ─────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="release.py",
        description="Build TheFlashMaster's Windows binaries locally and publish a GitHub Release on the git remote.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n  py -3 scripts/release.py\n  py -3 scripts/release.py --dry-run\n"
               "  py -3 scripts/release.py --bump minor --notes \"New agent panel\"\n"
               "  py -3 scripts/release.py --skip-build --version 0.3.1   (resume after a failed upload)",
    )
    v = p.add_mutually_exclusive_group()
    v.add_argument("--bump", choices=["patch", "minor", "major"], help="pick the next version without asking")
    v.add_argument("--version", help="exact version to release, e.g. 0.4.0 or 0.4.0-beta.1")
    p.add_argument("--notes", help="release notes (also shown by the in-app updater); default: GitHub's generated notes")
    p.add_argument("--notes-file", help="read release notes from a file (Markdown)")
    p.add_argument("--remote", default="origin", help="git remote to release to (default: origin)")
    p.add_argument("--prerelease", action="store_true", help="mark as pre-release (automatic for versions like 1.0.0-beta.1)")
    p.add_argument("--draft", action="store_true", help="upload everything but leave the release as a draft")
    p.add_argument("--dry-run", action="store_true", help="run the checks and show the plan; build and change nothing")
    p.add_argument("--no-publish", action="store_true", help="build and package locally, skip GitHub")
    p.add_argument("--skip-checks", action="store_true", help="skip `npm run ci` (typecheck, lint, tests) before packaging")
    p.add_argument("--skip-build", action="store_true", help="reuse the files already in release/ (resume a failed upload)")
    p.add_argument("--install", action="store_true", help="run `npm ci` when node_modules is missing")
    p.add_argument("--allow-dirty", action="store_true", help="allow uncommitted changes")
    p.add_argument("--allow-non-windows", action="store_true", help="try to build on macOS/Linux (needs Wine for NSIS)")
    p.add_argument("-y", "--yes", action="store_true", help="don't ask: suggested version, publish without confirmation")
    p.add_argument("--no-color", action="store_true", help="plain output")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
    args = build_parser().parse_args(argv)
    if args.notes and args.notes_file:
        build_parser().error("use --notes or --notes-file, not both")
    ui = UI(color=not args.no_color)
    ui.banner(f"{PRODUCT} release" + (" (dry run)" if args.dry_run else ""))
    try:
        return Release(args, ui).run()
    except ReleaseError as e:
        ui.clear_line()
        print(f"\n{ui.red(ui.bad)} {ui.bold(e.message)}")
        for line in e.hint.splitlines():
            print(f"  {ui.yellow('→')} {line}" if ui.unicode else f"  -> {line}")
        return 1
    except KeyboardInterrupt:
        ui.clear_line()
        print(f"\n{ui.yellow(ui.warn_mark)} Interrupted. package.json was restored; a draft release (if any) is kept for --skip-build.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
